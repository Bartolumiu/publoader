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
 * Nothing here does I/O, so every decision, including every reason a file is
 * left alone, is directly testable.
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
  /** `{namespace: {…}}`: one extension serving more than one catalogue. */
  nested: boolean;
  /** `forward` is `{externalId: mdId}`; `inverted` is `{mdId: [externalId, …]}`. */
  inner: "forward" | "inverted";
  /**
   * Spaces per level, read from the file. Absent means {@link DEFAULT_INDENT}.
   *
   * Optional because it is a layout detail rather than a shape, and because a
   * caller that only cares about the two axes above should not have to state
   * it.
   */
  indent?: number;
  /**
   * Right-align the keys inside an object so their closing quotes line up,
   * which is how alpha_manga's numeric ids are written. Absent means no.
   */
  align?: boolean;
}

/**
 * Spaces per level for a file that does not tell us otherwise.
 *
 * Four, because all three maps in the wild are written that way. This used to
 * be the `2` baked into a `JSON.stringify(…, 2)` call, which meant the first
 * sync reindented every line of every file it touched.
 */
export const DEFAULT_INDENT = 4;

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
 * entry and resolved by majority, because hand-edited files mix shapes; the
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
 * exists to prevent; and an extension with none must not be, because the
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

  return serialise(document, shape);
}

/** A JSON string literal. `JSON.stringify` is the escaping rule, not a guess. */
const quoted = (value: string): string => JSON.stringify(value);

/** `["100001", "200008"]` or `"aaaa-…"`. Always one line, however long. */
const inlineValue = (value: unknown): string =>
  Array.isArray(value) ? `[${value.map((item) => quoted(String(item))).join(", ")}]` : quoted(String(value));

/**
 * Serialise the map document the way these files are actually written.
 *
 * This was `JSON.stringify(document, null, 2)`, which is wrong in two ways that
 * only show up in a diff. It puts every array element on its own line, so a
 * mapping that reads `"<md id>": ["100001", "200008"]` becomes four lines; and
 * it hard-codes an indent none of the files use. The first weekly sync
 * therefore rewrote mangaplus from 761 lines to 2565 — a commit whose subject
 * said `+7 -1` and whose diff was the entire file. Nothing was wrong with the
 * data, but the one property that makes an unattended commit reviewable, that
 * the diff is the change, was gone.
 *
 * So: arrays inline, indent taken from the file, and the key alignment
 * preserved when the file has one. Still deterministic to the byte, which is
 * what stops a week with no changes from producing a commit.
 */
function serialise(document: Record<string, unknown>, shape: MapShape): string {
  const entries = Object.entries(document);
  if (entries.length === 0) return "{}\n";
  return ["{", ...commaJoin(objectBlocks(entries, 1, shape)), "}"].join("\n") + "\n";
}

/**
 * One block of lines per entry: a scalar or array is one line, a namespace is
 * its braces and everything inside them. Blocks rather than lines because only
 * the block knows which of its lines is the last, and that is the one a comma
 * goes on.
 */
function objectBlocks(entries: [string, unknown][], depth: number, shape: MapShape): string[][] {
  const base = " ".repeat((shape.indent ?? DEFAULT_INDENT) * depth);
  // Per object, not per file: each namespace aligns within itself.
  const widest = shape.align === true ? Math.max(0, ...entries.map(([key]) => key.length)) : 0;

  return entries.map(([key, value]) => {
    const label = `${base}${" ".repeat(Math.max(0, widest - key.length))}${quoted(key)}: `;
    if (!isPlainObject(value)) return [`${label}${inlineValue(value)}`];
    const inner = Object.entries(value);
    // `{}` on one line: viz has an empty namespace, and three lines to say
    // nothing is exactly the noise this function exists to remove.
    if (inner.length === 0) return [`${label}{}`];
    return [`${label}{`, ...commaJoin(objectBlocks(inner, depth + 1, shape)), `${base}}`];
  });
}

/** Flatten blocks into lines, putting a comma after every block but the last. */
function commaJoin(blocks: string[][]): string[] {
  return blocks.flatMap((block, index) =>
    index === blocks.length - 1 ? block : block.map((line, i) => (i === block.length - 1 ? `${line},` : line)),
  );
}

/**
 * Read a file's two whitespace conventions out of its text.
 *
 * `JSON.parse` throws both away, and they are most of what a diff shows: a
 * two-space rewrite of a four-space file is a hundred percent changed lines
 * that mean nothing at all.
 *
 * The indent is the smallest leading run on any key line, which is the width of
 * one level whether the file is flat or nested. Alignment is only considered
 * for a flat file: alpha_manga right-aligns its numeric ids so every key ends
 * in the same column, and the tell is that the leading runs differ while the
 * ending column does not. Deciding that per-namespace for a nested file would
 * be more guesswork than it is worth, and viz, the only nested file, does not
 * align.
 */
export function detectLayout(text: string, nested: boolean): { indent: number; align: boolean } {
  const leads: number[] = [];
  const ends: number[] = [];
  for (const line of text.split("\n")) {
    const match = /^( +)"((?:[^"\\]|\\.)*)"\s*:/.exec(line);
    if (!match) continue;
    leads.push(match[1]!.length);
    ends.push(match[1]!.length + match[2]!.length);
  }
  if (leads.length === 0) return { indent: DEFAULT_INDENT, align: false };

  const indent = Math.min(...leads);
  if (nested || new Set(leads).size === 1) return { indent, align: false };
  // Every key ending in the same column, with the runs in front of them
  // differing, is alignment and cannot readily be anything else.
  const dominant = Math.max(...countBy(ends).values());
  return { indent, align: dominant / ends.length >= 0.98 };
}

function countBy(values: number[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const value of values) out.set(value, (out.get(value) ?? 0) + 1);
  return out;
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
 * not evidence of anything; going from 3 rows to 1 is a normal edit.
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
  const shape = detectMapShape(document);
  return {
    rows: parseMangaIdMapFile(document),
    // The layout comes from the text because the parse has already lost it.
    shape: shape ? { ...shape, ...detectLayout(text, shape.nested) } : null,
  };
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
