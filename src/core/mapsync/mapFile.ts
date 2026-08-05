/**
 * Rendering the tracked series map back into a `manga_id_map.json` file, and
 * deciding whether that file is worth rewriting.
 *
 * Direction matters here. Everywhere else in the platform the file flows INTO
 * the database (`BundleStore.seedConfigFromBundle` seeds missing rows and never
 * overwrites); this module is the return trip, and the database is the
 * authority. The files in git are what contributors read and edit, and without
 * a write-back they drift: every title the pipeline auto-creates and every
 * operator repoint is invisible in the repo, so a contributor opens a pull
 * request adding a series that has been tracked for months.
 *
 * Nothing here does I/O, so every decision — including every reason a file is
 * left alone — is directly testable.
 */
import { parseMangaIdMapFile, type ParsedIdMapRow } from "../store/bundles.js";
import { DEFAULT_NAMESPACE } from "../store/trackedManga.js";

/** Where the map lives when the manifest's `data_files` does not say. */
export const DEFAULT_MAP_FILENAME = "manga_id_map.json";

/**
 * The three shapes the real files use, as two independent axes. See
 * `parseMangaIdMapFile` for the wild examples: mangaplus is flat+inverted,
 * alpha_manga is flat+forward, viz is nested+forward.
 */
export interface MapShape {
  /** `{namespace: {…}}` — one extension serving more than one catalogue. */
  nested: boolean;
  /** `forward` is `{externalId: mdId}`; `inverted` is `{mdId: [externalId, …]}`. */
  inner: "forward" | "inverted";
}

/**
 * What a brand-new file would look like. Inverted because that is the shape the
 * worker receives on the wire (`buildMangaIdMap`), so a reader who knows one
 * knows the other.
 */
export const DEFAULT_SHAPE: MapShape = { nested: false, inner: "inverted" };

/**
 * Guess the shape of a file we are about to overwrite.
 *
 * Preserving it is the difference between a diff a contributor can review and a
 * diff that rewrites every line of a file they curated. The judgement is per
 * entry and resolved by majority, because hand-edited files mix shapes — the
 * same tolerance `parseMangaIdMapFile` already has. Null means "nothing here
 * looks like a map", and the caller must not overwrite on a guess.
 */
export function detectMapShape(document: unknown): MapShape | null {
  if (!isPlainObject(document)) return null;
  let nested = 0;
  let forward = 0;
  let inverted = 0;

  const tallyFlat = (entries: Record<string, unknown>): void => {
    for (const value of Object.values(entries)) {
      if (Array.isArray(value)) inverted += 1;
      else if (typeof value === "string" || typeof value === "number") forward += 1;
    }
  };

  for (const value of Object.values(document)) {
    if (isPlainObject(value)) {
      nested += 1;
      tallyFlat(value);
    } else {
      tallyFlat({ _: value });
    }
  }
  if (nested === 0 && forward === 0 && inverted === 0) return null;
  return { nested: nested > 0, inner: inverted > forward ? "inverted" : "forward" };
}

/**
 * Render tracked rows as the text of a `manga_id_map.json`.
 *
 * Deterministic to the byte: keys sorted, arrays sorted, two-space indent, one
 * trailing newline. A weekly job that emitted a different-but-equivalent
 * ordering would commit a churn diff every week forever, and "the file changed"
 * would stop meaning "the map changed".
 *
 * Nesting is decided by the ROWS, not by `shape.nested`: an extension with a
 * namespaced row must be written nested, because flattening viz's two
 * catalogues into one object is exactly the collision the namespace column
 * exists to prevent — and an extension with none must not be, because the
 * alternative is a file with a meaningless `""` key at the top. Only
 * `shape.inner` is taken from the existing file.
 */
export function renderMapFile(rows: ParsedIdMapRow[], shape: MapShape = DEFAULT_SHAPE): string {
  const nest = rows.some((row) => row.namespace !== DEFAULT_NAMESPACE);

  const flat = (subset: ParsedIdMapRow[]): Record<string, unknown> => {
    if (shape.inner === "forward") {
      const out: Record<string, string> = {};
      for (const row of [...subset].sort(byMangaId)) out[row.mangaId] = row.mdMangaId;
      return out;
    }
    const grouped = new Map<string, string[]>();
    for (const row of subset) {
      const bucket = grouped.get(row.mdMangaId);
      if (bucket) bucket.push(row.mangaId);
      else grouped.set(row.mdMangaId, [row.mangaId]);
    }
    const out: Record<string, string[]> = {};
    for (const key of [...grouped.keys()].sort()) out[key] = grouped.get(key)!.sort(compareIds);
    return out;
  };

  const document = nest
    ? Object.fromEntries(
        [...new Set(rows.map((row) => row.namespace))]
          .sort()
          .map((namespace) => [namespace, flat(rows.filter((row) => row.namespace === namespace))]),
      )
    : flat(rows);

  return JSON.stringify(document, null, 2) + "\n";
}

/**
 * The identity of a mapping, for counting and comparison. Deliberately the same
 * triple the `tracked_manga` unique constraint uses.
 */
function rowKey(row: ParsedIdMapRow): string {
  return JSON.stringify([row.namespace, row.mangaId, row.mdMangaId]);
}

/** Mappings in `a` that `b` does not have. */
export function mappingsMissingFrom(a: ParsedIdMapRow[], b: ParsedIdMapRow[]): ParsedIdMapRow[] {
  const have = new Set(b.map(rowKey));
  return a.filter((row) => !have.has(rowKey(row)));
}

export type WriteAction = "write" | "unchanged" | "skipped" | "refused";

export interface WritePlan {
  action: WriteAction;
  /** Operator-readable, and the audit detail when the action is `refused`. */
  reason?: string;
  /** Mappings the file has that the database does not. Non-empty means a deletion. */
  removed: number;
  /** Mappings the database has that the file does not. */
  added: number;
}

/**
 * Below this many mappings in the current file, a large proportional shrink is
 * not evidence of anything — going from 3 rows to 1 is a normal edit.
 */
export const SHRINK_GUARD_MIN_ROWS = 8;

/**
 * Refuse a write that would delete more than this fraction of the file's
 * mappings. The database is authoritative, but "authoritative" and "correct
 * right now" are not the same claim: a half-run migration, a truncated table or
 * a filter bug would otherwise be committed straight into the repo by a job
 * nobody is watching. Git makes it recoverable; a refusal makes it unnecessary.
 */
export const SHRINK_GUARD_FRACTION = 0.5;

/**
 * Decide what to do with one file.
 *
 * `current` is null when the file is not in the repo. That case is SKIPPED
 * rather than created: the extension's map location is a convention its author
 * chose, and inventing the file (and its shape) in someone's repository is a
 * bigger step than keeping an existing one current.
 */
export function planWrite(
  current: { text: string; rows: ParsedIdMapRow[] } | null,
  next: { text: string; rows: ParsedIdMapRow[] },
  opts: { force?: boolean } = {},
): WritePlan {
  if (current === null) {
    return {
      action: "skipped",
      reason: "the file is not in the repo; create it once by hand and the sync will keep it current",
      removed: 0,
      added: next.rows.length,
    };
  }

  const removedRows = mappingsMissingFrom(current.rows, next.rows);
  const addedRows = mappingsMissingFrom(next.rows, current.rows);
  const counts = { removed: removedRows.length, added: addedRows.length };

  if (current.text === next.text) return { action: "unchanged", ...counts };

  if (next.rows.length === 0 && current.rows.length > 0) {
    return {
      action: "refused",
      reason: "the database has no mappings for this extension; refusing to empty a file that has some",
      ...counts,
    };
  }
  if (
    !opts.force &&
    current.rows.length >= SHRINK_GUARD_MIN_ROWS &&
    next.rows.length < current.rows.length * SHRINK_GUARD_FRACTION
  ) {
    return {
      action: "refused",
      reason:
        `would drop ${counts.removed} of ${current.rows.length} mappings; refusing a shrink of more than ` +
        `${Math.round((1 - SHRINK_GUARD_FRACTION) * 100)}% without --force`,
      ...counts,
    };
  }
  return { action: "write", ...counts };
}

/** Parse a file's text the way the platform already reads these files. */
export function parseMapText(text: string): { rows: ParsedIdMapRow[]; shape: MapShape | null } {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return { rows: [], shape: null };
  }
  return { rows: parseMangaIdMapFile(document), shape: detectMapShape(document) };
}

/**
 * Numeric-aware ordering, so `10` sorts after `9` rather than after `1`. These
 * ids are numbers in a string in most extensions, and a lexicographic list is
 * unreadable to the humans who edit these files.
 */
const compareIds = (a: string, b: string): number =>
  a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }) || (a < b ? -1 : a > b ? 1 : 0);

const byMangaId = (a: ParsedIdMapRow, b: ParsedIdMapRow): number => compareIds(a.mangaId, b.mangaId);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
