import { createHash } from "node:crypto";
import AdmZip from "adm-zip";
import type { PrismaClient, Bundle } from "@prisma/client";
import { Manifest } from "../../contracts/manifest.js";

/**
 * Content-addressed extension bundles. A bundle is a zip of one extension
 * directory, published by the operator (CLI/admin API) from a known repo
 * commit. Workers download by extension+sha256 and verify the hash before
 * execution — the sha256 in the job spec is the version pin.
 */
export class BundleStore {
  constructor(private readonly prisma: PrismaClient) {}

  async publish(opts: {
    zipData: Buffer;
    manifest: unknown;
    sourceCommit?: string;
  }): Promise<{ bundle: Bundle; created: boolean }> {
    const manifest = Manifest.parse(opts.manifest);
    const sha256 = createHash("sha256").update(opts.zipData).digest("hex");

    const existing = await this.prisma.bundle.findUnique({ where: { sha256 } });
    if (existing) return { bundle: existing, created: false };

    const bundle = await this.prisma.bundle.upsert({
      where: { extension_version: { extension: manifest.name, version: manifest.version } },
      create: {
        extension: manifest.name,
        version: manifest.version,
        sha256,
        manifest: manifest as object,
        sourceCommit: opts.sourceCommit ?? null,
        data: new Uint8Array(opts.zipData),
      },
      // Same extension+version republished with different content: replace,
      // new sha becomes the pin for future jobs (old jobs keep their pin but
      // can no longer fetch the old bytes — republish under a new version to
      // keep both).
      update: {
        sha256,
        manifest: manifest as object,
        sourceCommit: opts.sourceCommit ?? null,
        data: new Uint8Array(opts.zipData),
        yanked: false,
      },
    });
    await this.seedConfigFromBundle(manifest, opts.zipData);
    return { bundle, created: true };
  }

  /**
   * One-time import of the bundle's legacy JSON data files into the database.
   * The DB is the source of truth for runtime config: existing TrackedManga
   * rows and ExtensionConfig are never overwritten by later publishes — the
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

    // manga_id_map.json: { md_manga_id: [external ids] } -> TrackedManga rows.
    // Falls back to the conventional filename when data_files doesn't map it.
    const idMap = readJson(manifest.data_files["manga_id_map"] ?? "manga_id_map.json");
    if (idMap && typeof idMap === "object" && !Array.isArray(idMap)) {
      const rows: { extension: string; mangaId: string; mdMangaId: string; source: string }[] = [];
      for (const [mdMangaId, externals] of Object.entries(idMap as Record<string, unknown>)) {
        if (!Array.isArray(externals)) continue;
        for (const external of externals) {
          rows.push({
            extension: manifest.name,
            mangaId: String(external),
            mdMangaId,
            source: "bundle-import",
          });
        }
      }
      if (rows.length > 0) {
        await this.prisma.trackedManga.createMany({ data: rows, skipDuplicates: true });
      }
    }

    // override_options.json -> ExtensionConfig (create-only; DB wins afterwards).
    const overrides = readJson(manifest.data_files["override_options"] ?? "override_options.json");
    if (overrides && typeof overrides === "object") {
      await this.prisma.extensionConfig.upsert({
        where: { extension: manifest.name },
        create: { extension: manifest.name, overrideOptions: overrides as object },
        update: {},
      });
    }
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
