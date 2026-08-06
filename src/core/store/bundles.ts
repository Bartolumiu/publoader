import { createHash } from "node:crypto";
import AdmZip from "adm-zip";
import type { PrismaClient, Bundle } from "@prisma/client";
import { Manifest, manifestRuntime } from "../../contracts/manifest.js";
import { normaliseMangadexLanguage } from "../../contracts/languages.js";
import { ExtensionConfigStore } from "./extensionConfig.js";
import { DEFAULT_NAMESPACE, normaliseNamespace } from "./trackedManga.js";

/** A bundle that cannot be accepted as published. Surfaces as a 422. */
export class BundleRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleRejectedError";
  }
}

/**
 * Content-addressed extension bundles. A bundle is a zip of one extension
 * directory, published by the operator (CLI/admin API) from a known repo
 * commit. Workers download by extension+sha256 and verify the hash before
 * execution; the sha256 in the job spec is the version pin.
 */
export class BundleStore {
  constructor(private readonly prisma: PrismaClient) {}

  async publish(opts: {
    zipData: Buffer;
    manifest: unknown;
    sourceCommit?: string;
    /**
     * Escape hatch for republishing a pre-v2 python bundle (operator-only,
     * audit-logged at the route). Not for new work; it exists so a rollback
     * to a known-good legacy bundle is possible without a code change.
     */
    allowLegacy?: boolean;
  }): Promise<{ bundle: Bundle; created: boolean; warnings: string[] }> {
    const manifest = Manifest.parse(opts.manifest);
    const runtime = manifestRuntime(manifest);

    if (runtime === "python" && opts.allowLegacy !== true) {
      throw new BundleRejectedError(
        "python bundles are no longer accepted; port to extension API v2 " +
          '(set publoader_api "^2.0.0", runtime "node", and default-export an ' +
          "ExtensionFactory from a single ESM entrypoint)",
      );
    }
    if (runtime === "node") {
      assertNodeEntrypoint(manifest, opts.zipData);
    }

    // A language MangaDex does not have is a WARNING, not a rejection. It is
    // worth surfacing while an operator is watching (it is almost always a typo
    // like `pt_br`, and a chapter in an undeclared language is dropped at
    // ingest), but MangaDex adds codes and this list would then block a
    // perfectly good bundle with no way to override it. `custom_language` is
    // enforced rather than warned, because there the failure is silent: an
    // unrecognised code there widens the keep-set by nothing and quietly stops
    // protecting chapters from the removal pass.
    const warnings = manifest.languages
      .filter((language) => normaliseMangadexLanguage(language) === null)
      .map((language) => `manifest language ${JSON.stringify(language)} is not a MangaDex language code`);

    const sha256 = createHash("sha256").update(opts.zipData).digest("hex");

    const existing = await this.prisma.bundle.findUnique({ where: { sha256 } });
    if (existing) return { bundle: existing, created: false, warnings };

    const bundle = await this.prisma.bundle.upsert({
      where: { extension_version: { extension: manifest.name, version: manifest.version } },
      create: {
        extension: manifest.name,
        version: manifest.version,
        sha256,
        manifest: manifest as object,
        sourceCommit: opts.sourceCommit ?? null,
        archive: new Uint8Array(opts.zipData),
      },
      // Same extension+version republished with different content: replace,
      // new sha becomes the pin for future jobs (old jobs keep their pin but
      // can no longer fetch the old bytes; republish under a new version to
      // keep both).
      update: {
        sha256,
        manifest: manifest as object,
        sourceCommit: opts.sourceCommit ?? null,
        archive: new Uint8Array(opts.zipData),
        yanked: false,
      },
    });
    await this.seedConfigFromBundle(manifest, opts.zipData);
    return { bundle, created: true, warnings };
  }

  /**
   * One-time import of the bundle's legacy JSON data files into the database.
   * The DB is the source of truth for runtime config: existing TrackedManga
   * rows and ExtensionConfig are never overwritten by later publishes; the
   * files only seed missing state (migration convenience).
   */
  private async seedConfigFromBundle(manifest: Manifest, zipData: Buffer): Promise<void> {
    let zip: AdmZip;
    try {
      zip = new AdmZip(zipData);
    } catch {
      return;
    }
    const readJson = (name: string | undefined): unknown => {
      if (!name) return undefined;
      const entry = zip.getEntry(name);
      if (!entry) return undefined;
      try {
        return JSON.parse(entry.getData().toString("utf8"));
      } catch {
        return undefined;
      }
    };

    // manga_id_map.json -> TrackedManga rows. Falls back to the conventional
    // filename when data_files doesn't map it.
    const idMap = readJson(manifest.data_files["manga_id_map"] ?? "manga_id_map.json");
    const parsed = parseMangaIdMapFile(idMap);
    if (parsed.length > 0) {
      await this.reconcileTrackedManga(manifest.name, parsed);
    }

    // override_options.json -> the three config tables plus the free-form
    // remainder (create-only; DB wins afterwards).
    const overrides = readJson(manifest.data_files["override_options"] ?? "override_options.json");
    if (overrides && typeof overrides === "object") {
      await new ExtensionConfigStore(this.prisma).seedIfAbsent(manifest.name, overrides);
    }
  }

  /**
   * Reconcile the bundle's `manga_id_map.json` against the tracked table.
   *
   * The database is authoritative for the tracked map, but contributors still
   * add series by editing that file and opening a pull request; so a publish
   * has to honour the file without trampling decisions made after it.
   * `source` is what makes that possible:
   *
   *   - a new pair is inserted, which is the contributor workflow;
   *   - a pair whose row came from a previous import (`bundle-import`) is
   *     updated, so correcting a wrong id in git takes effect;
   *   - a row an operator set by hand (`operator:…`) or the title pipeline
   *     created (`auto`) is left alone, because it represents a later and more
   *     informed decision than the file's.
   *
   * Nothing is ever deleted here: removing a line from the map must not silently
   * stop a series from being tracked. Untracking is an explicit operator action
   * (dashboard, `publoader-admin tracked remove`, or the bot).
   */
  private async reconcileTrackedManga(
    extension: string,
    rows: ParsedIdMapRow[],
  ): Promise<{ added: number; updated: number; preserved: number }> {
    if (rows.length === 0) return { added: 0, updated: 0, preserved: 0 };

    const existing = await this.prisma.trackedManga.findMany({
      where: { extension },
      select: { namespace: true, mangaId: true, mdMangaId: true, source: true },
    });
    // Keyed on the row identity, (namespace, mangaId), not on mangaId alone.
    // Keying on the external id by itself is what let viz's two catalogues,
    // which reuse numeric ids, overwrite each other.
    const byPair = new Map(
      existing.map((row) => [JSON.stringify([row.namespace, row.mangaId]), row]),
    );

    const toInsert: ParsedIdMapRow[] = [];
    const toUpdate: ParsedIdMapRow[] = [];
    let preserved = 0;

    for (const row of rows) {
      const current = byPair.get(JSON.stringify([row.namespace, row.mangaId]));
      if (!current) {
        toInsert.push(row);
      } else if (current.mdMangaId === row.mdMangaId) {
        // Already correct; nothing to do.
      } else if (current.source === "bundle-import") {
        toUpdate.push(row);
      } else {
        preserved += 1;
      }
    }

    if (toInsert.length > 0) {
      await this.prisma.trackedManga.createMany({
        data: toInsert.map((row) => ({ extension, ...row, source: "bundle-import" })),
        skipDuplicates: true,
      });
    }
    for (const row of toUpdate) {
      await this.prisma.trackedManga.updateMany({
        where: {
          extension,
          namespace: row.namespace,
          mangaId: row.mangaId,
          source: "bundle-import",
        },
        data: { mdMangaId: row.mdMangaId },
      });
    }
    return { added: toInsert.length, updated: toUpdate.length, preserved };
  }

  /** Latest non-yanked bundle per extension (the scheduler's default pin). */
  async latest(extension: string): Promise<Bundle | null> {
    return this.prisma.bundle.findFirst({
      where: { extension, yanked: false },
      orderBy: { publishedAt: "desc" },
    });
  }

  async bySha(sha256: string): Promise<Bundle | null> {
    return this.prisma.bundle.findUnique({ where: { sha256 } });
  }

  async listLatest(): Promise<Bundle[]> {
    const bundles = await this.prisma.bundle.findMany({
      where: { yanked: false },
      orderBy: { publishedAt: "desc" },
    });
    const seen = new Set<string>();
    const latest: Bundle[] = [];
    for (const b of bundles) {
      if (!seen.has(b.extension)) {
        seen.add(b.extension);
        latest.push(b);
      }
    }
    return latest;
  }

  async yank(extension: string, version: string): Promise<boolean> {
    const res = await this.prisma.bundle.updateMany({
      where: { extension, version },
      data: { yanked: true },
    });
    return res.count === 1;
  }
}

export interface ParsedIdMapRow {
  namespace: string;
  mangaId: string;
  mdMangaId: string;
}

const MD_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read a bundle's `manga_id_map.json` in every shape the real files use.
 *
 * There are three in the wild and the parser must not guess wrong, because a
 * misread map means either "nothing is tracked" (every series is reported
 * untracked) or, worse, series pointed at the wrong MangaDex title:
 *
 *   {mdMangaId: [externalId, …]}          mangaplus; many external ids per
 *                                         title, one per language edition
 *   {externalId: mdMangaId}               alpha_manga, the forward direction
 *   {namespace: {externalId: mdMangaId}}  viz, TWO catalogues (`shonenjump`,
 *                                         `vizmanga`) in one extension, where
 *                                         the same numeric id under each is a
 *                                         different series
 *
 * They are told apart by the type of each top-level value (array, string,
 * object), per entry rather than for the file as a whole, so a hand-edited file
 * that mixes them still imports. A namespace's contents may themselves be in
 * either flat shape. The MangaDex side is always the uuid; a row where neither
 * side is one is skipped rather than inserted backwards.
 */
export function parseMangaIdMapFile(document: unknown): ParsedIdMapRow[] {
  if (!isPlainObject(document)) return [];
  const rows: ParsedIdMapRow[] = [];

  const addFlat = (namespace: string, entries: Record<string, unknown>): void => {
    for (const [key, value] of Object.entries(entries)) {
      if (Array.isArray(value)) {
        // {mdMangaId: [externalId, …]}
        if (!MD_UUID_RE.test(key)) continue;
        for (const external of value) {
          if (typeof external !== "string" && typeof external !== "number") continue;
          const mangaId = String(external);
          if (mangaId.length === 0) continue;
          rows.push({ namespace, mangaId, mdMangaId: key.toLowerCase() });
        }
      } else if (typeof value === "string" || typeof value === "number") {
        // {externalId: mdMangaId}
        const mdMangaId = String(value);
        if (!MD_UUID_RE.test(mdMangaId) || key.length === 0) continue;
        rows.push({ namespace, mangaId: key, mdMangaId: mdMangaId.toLowerCase() });
      }
    }
  };

  for (const [key, value] of Object.entries(document)) {
    if (isPlainObject(value)) {
      // A namespace. Nesting stops here: two levels is what the files have, and
      // accepting more would make an accidentally double-wrapped file look valid.
      addFlat(normaliseNamespace(key), value);
    } else {
      addFlat(DEFAULT_NAMESPACE, { [key]: value });
    }
  }
  return rows;
}

/**
 * Best-effort check that a node bundle's entrypoint is actually there and
 * actually an ES module with a default export.
 *
 * Not a parser: the real validation is that the runner imports the file and
 * refuses it if `default` is not a function. This just fails at publish, where
 * an operator is watching, rather than on a worker an hour later.
 */
function assertNodeEntrypoint(manifest: Manifest, zipData: Buffer): void {
  let zip: AdmZip;
  try {
    zip = new AdmZip(zipData);
  } catch {
    throw new BundleRejectedError("bundle is not a readable zip");
  }
  const entry = zip.getEntry(manifest.entrypoint);
  if (!entry) {
    throw new BundleRejectedError(
      `entrypoint ${manifest.entrypoint} is missing from the bundle`,
    );
  }
  if (!/\.(mjs|js)$/.test(manifest.entrypoint)) {
    throw new BundleRejectedError(
      `entrypoint ${manifest.entrypoint} must be .mjs or .js for a node bundle`,
    );
  }
  const source = entry.getData().toString("utf8");
  if (source.trim().length === 0) {
    throw new BundleRejectedError(`entrypoint ${manifest.entrypoint} is empty`);
  }
  if (!DEFAULT_EXPORT_RE.test(source)) {
    throw new BundleRejectedError(
      `entrypoint ${manifest.entrypoint} has no default export; an extension must ` +
        "default-export an ExtensionFactory",
    );
  }
}

/**
 * Recognise a default export in the forms a bundler actually emits.
 *
 * A plain `source.includes("export default")` looked sufficient and was not:
 * esbuild rewrites `export default factory` into `export { factory as default }`
 * when it bundles, so every TypeScript extension built through the publish
 * pipeline would have been rejected with "has no default export"; a confusing
 * failure for a bundle that is completely correct.
 *
 * This stays a cheap textual check on purpose. The authoritative validation is
 * the runner importing the module and refusing it if `default` is not a
 * function; the point here is only to fail fast at publish, while an operator is
 * watching, for the obvious mistake of shipping a module with no default at all.
 */
const DEFAULT_EXPORT_RE = new RegExp(
  [
    "export\\s+default",           // export default factory
    "as\\s+default\\s*[},]",       // export { factory as default }
    "exports\\.default",           // CJS interop
    'exports\\[["\']default',      // exports["default"]
  ].join("|"),
);
