import { Prisma } from "@prisma/client";

/**
 * Ordering a whole listing by a column the operator picked, and paging that
 * ordering by keyset.
 *
 * The console's tables sort from their headers. Sorting them in the browser
 * orders the rows that happen to be on screen, which for a table the server
 * pages is the wrong answer to the question being asked: "show me the oldest"
 * means the oldest of everything matching the filter, not the oldest of the
 * hundred rows already fetched. So the chosen column is sent to the server, and
 * the server orders the whole result by it.
 *
 * That turns every paged listing into "order by an arbitrary column, and page
 * it", which is what this module is. Offset paging would be the easy way and is
 * the wrong one for the same reason it always was here: the queue drains while
 * it is being read, so page two of an offset scan skips rows that moved and
 * repeats rows that did not. Keyset paging survives that, and keyset paging
 * over an arbitrary column needs three things kept in step — the ORDER BY, the
 * "strictly after the cursor" predicate, and the cursor itself. Keeping them in
 * step by hand at seven call sites is how they drift, so they are all derived
 * here from one list of keys.
 *
 * The only rule imposed on a key is that it must never be NULL: the comparison
 * below is a chain of `=` and `<`/`>`, and a NULL anywhere in it silently drops
 * the row rather than ordering it. That is what the `...Keys` builders are for.
 * Each turns one possibly-null column into a pair of keys — "is this blank?"
 * and "the value, or a stand-in" — neither of which can be NULL.
 */

export type SortDir = "asc" | "desc";

export function isSortDir(value: unknown): value is SortDir {
  return value === "asc" || value === "desc";
}

/**
 * One key of a total ordering.
 *
 * `dir: "follow"` flips with the direction the operator asked for. `dir: "asc"`
 * never flips, which is what keeps blanks at the bottom of a descending sort as
 * well as an ascending one: reversing a column is a request for the other end
 * of its values, not a request to be shown the rows that have none. The
 * browser-side sort has always behaved that way, and a column that jumped its
 * blanks to the top the moment the server took the sort over would read as a
 * bug in the sort rather than as a difference in where it ran.
 */
export interface OrderKey {
  /** SQL for the value. Must not evaluate to NULL for any row. */
  sql: Prisma.Sql;
  /** How this key's cursor text is read back for the comparison. */
  cast: "text" | "numeric" | "timestamp" | "timestamptz" | "boolean";
  dir: "follow" | "asc";
}

/** A column a listing may be ordered by, as the keys that order it. */
export type SortColumns = Record<string, OrderKey[]>;

/**
 * Text, ordered with blanks last.
 *
 * Blank means NULL or empty here, not just NULL: a column rendered as "-" in
 * the console is as often `''` as it is null, and an operator sorting by Series
 * does not distinguish the two. Trimmed for the same reason.
 */
export function textKeys(sql: Prisma.Sql): OrderKey[] {
  const value = Prisma.sql`nullif(btrim(${sql}), '')`;
  return [
    { sql: Prisma.sql`(${value} IS NULL)`, cast: "boolean", dir: "asc" },
    { sql: Prisma.sql`coalesce(${value}, '')`, cast: "text", dir: "follow" },
  ];
}

/** A numeric column, ordered with NULLs last. */
export function numberKeys(sql: Prisma.Sql): OrderKey[] {
  return [
    { sql: Prisma.sql`(${sql} IS NULL)`, cast: "boolean", dir: "asc" },
    { sql: Prisma.sql`coalesce((${sql})::numeric, 0)`, cast: "numeric", dir: "follow" },
  ];
}

/**
 * A number that is stored as text, ordered as a number.
 *
 * Chapter and volume numbers are text (they have to be: "10.5", "Extra"), and
 * ordering them as text is the 1, 10, 2 problem in the place an operator is
 * most likely to notice it. Anything that is not a plain decimal — "Extra", or
 * an empty string — has no numeric order at all, so it sorts as blank rather
 * than as zero, which would slot it in among the real chapter ones.
 */
export function numericTextKeys(sql: Prisma.Sql): OrderKey[] {
  const value = Prisma.sql`(CASE WHEN btrim(${sql}) ~ '^[0-9]+(\\.[0-9]+)?$'
                                 THEN btrim(${sql})::numeric END)`;
  return [
    { sql: Prisma.sql`(${value} IS NULL)`, cast: "boolean", dir: "asc" },
    { sql: Prisma.sql`coalesce(${value}, 0)`, cast: "numeric", dir: "follow" },
  ];
}

/** A timestamp column, ordered with NULLs last. */
export function timeKeys(sql: Prisma.Sql): OrderKey[] {
  return [
    { sql: Prisma.sql`(${sql} IS NULL)`, cast: "boolean", dir: "asc" },
    {
      sql: Prisma.sql`coalesce(${sql}, '-infinity'::timestamp)`,
      cast: "timestamp",
      dir: "follow",
    },
  ];
}

/**
 * A timestamp that is stored as text, ordered as a timestamp.
 *
 * The chapters a run reported live in a JSON envelope, so their instants arrive
 * as strings. The cast is guarded because it is the kind that raises rather
 * than returning NULL: one chapter whose timestamp an extension wrote in some
 * other shape would take down the whole listing, so anything that is not
 * plainly a date sorts as blank instead.
 */
export function isoTimeKeys(sql: Prisma.Sql): OrderKey[] {
  const value = Prisma.sql`(CASE WHEN ${sql} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
                                 THEN (${sql})::timestamptz END)`;
  return [
    { sql: Prisma.sql`(${value} IS NULL)`, cast: "boolean", dir: "asc" },
    {
      sql: Prisma.sql`coalesce(${value}, '-infinity'::timestamptz)`,
      cast: "timestamptz",
      dir: "follow",
    },
  ];
}

/** A column that is already non-null: ordered directly, with no blank key. */
export function plainKey(sql: Prisma.Sql, cast: OrderKey["cast"]): OrderKey[] {
  return [{ sql, cast, dir: "follow" }];
}

/** The alias each key is selected under, so a page's last row can be read back. */
const alias = (index: number) => `_sort${index}`;

function bind(key: OrderKey, value: string): Prisma.Sql {
  switch (key.cast) {
    case "numeric":
      return Prisma.sql`${value}::numeric`;
    case "timestamp":
      return Prisma.sql`${value}::timestamp`;
    case "timestamptz":
      return Prisma.sql`${value}::timestamptz`;
    case "boolean":
      return Prisma.sql`${value}::boolean`;
    default:
      return Prisma.sql`${value}::text`;
  }
}

/** A cursor value, as the text the codec below round-trips. */
function asText(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value ?? "");
}

/**
 * A cursor over an arbitrary ordering: the sort's own name and the key values
 * of the last row of the page.
 *
 * The name is carried so a cursor cannot outlive the ordering it names. A
 * client that pages to the third page and then re-sorts is asking a new
 * question, and its old cursor names a row in the answer to the old one;
 * without the name the values would simply be cast to the new key types and
 * silently page from nowhere in particular.
 *
 * Base64url of a JSON array, rather than a delimiter, because the values are
 * operator data: a series called "a|b" is not a reason to lose a page boundary.
 */
export function encodeSortCursor(sort: string, dir: SortDir, values: string[]): string {
  return Buffer.from(JSON.stringify([sort, dir, ...values]), "utf8").toString("base64url");
}

/** Null for anything that is not this ordering's cursor; the caller answers 400. */
export function decodeSortCursor(raw: string, sort: string, dir: SortDir, keys: number): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== keys + 2) return null;
  if (parsed[0] !== sort || parsed[1] !== dir) return null;
  const values = parsed.slice(2);
  return values.every((value) => typeof value === "string") ? (values as string[]) : null;
}

export interface Ordering {
  /** Appended to a SELECT list, exposing the keys so a cursor can be minted. */
  select: Prisma.Sql;
  /** The ORDER BY clause, keys in order. */
  orderBy: Prisma.Sql;
  /** Rows strictly after `values`, or null when there is no cursor. */
  after(values: string[] | null): Prisma.Sql | null;
  /** The cursor for a page's last row. */
  cursorOf(row: Record<string, unknown>): string[];
  /** The row without the key aliases, which are plumbing and not data. */
  strip<T extends Record<string, unknown>>(row: T): T;
  /** How many keys a cursor for this ordering carries. */
  size: number;
}

/**
 * Bind a list of keys and a direction into the three fragments a paged query
 * needs, plus the cursor codec that matches them.
 *
 * `id` is appended by the caller as the last key and is what makes the ordering
 * total. Without it a page boundary can fall in the middle of a run of equal
 * values, and every row sharing that value is either shown twice or not at all.
 */
export function ordering(keys: OrderKey[], dir: SortDir): Ordering {
  const dirOf = (key: OrderKey): SortDir => (key.dir === "asc" ? "asc" : dir);

  return {
    size: keys.length,

    select: Prisma.join(
      keys.map((key, index) => Prisma.sql`${key.sql} AS ${Prisma.raw(`"${alias(index)}"`)}`),
      ", ",
    ),

    orderBy: Prisma.join(
      keys.map((key) => Prisma.sql`${key.sql} ${Prisma.raw(dirOf(key) === "asc" ? "ASC" : "DESC")}`),
      ", ",
    ),

    after(values) {
      if (!values) return null;
      // Lexicographic, spelled out rather than written as a row comparison:
      // `(a, b) > (x, y)` needs one direction for the whole tuple, and the
      // blank keys above deliberately hold their direction while the value keys
      // flip. Equal prefix, then one strict comparison, for each key in turn.
      const clauses = keys.map((key, index) => {
        const prefix = keys
          .slice(0, index)
          .map((earlier, at) => Prisma.sql`${earlier.sql} = ${bind(earlier, values[at]!)}`);
        const op = Prisma.raw(dirOf(key) === "asc" ? ">" : "<");
        const step = Prisma.sql`${key.sql} ${op} ${bind(key, values[index]!)}`;
        return Prisma.sql`(${Prisma.join([...prefix, step], " AND ")})`;
      });
      return Prisma.sql`(${Prisma.join(clauses, " OR ")})`;
    },

    cursorOf(row) {
      return keys.map((_, index) => asText(row[alias(index)]));
    },

    strip(row) {
      const out = { ...row };
      for (let index = 0; index < keys.length; index++) delete out[alias(index)];
      return out;
    },
  };
}

/**
 * Resolve a requested sort against what a listing will actually order by.
 *
 * An unknown column is refused rather than ignored. Ignoring it would answer a
 * different question than the one asked and look, from the console, exactly
 * like a sort that does not work: the header would show as sorted and the rows
 * would come back in the default order.
 */
/** What a caller asked a listing to be ordered by, and where it had got to. */
export interface SortRequest {
  /** The column, as the console names it; one of the listing's `SortColumns`. */
  name: string;
  dir: SortDir;
  /** A cursor issued by a previous page of this same ordering. */
  cursor?: string | null;
}

export interface SortedListing {
  name: string;
  dir: SortDir;
  order: Ordering;
  /** The cursor's key values, or null on the first page. */
  after: string[] | null;
}

/**
 * Everything a listing needs to answer one sorted, paged request: the SQL
 * fragments, and the position the cursor names within them.
 *
 * The single entry point on purpose. The three things that have to agree — the
 * ORDER BY, the cursor predicate and the cursor's own contents — are only
 * correct together, and a caller that reached for them separately would be
 * free to build a page ordered one way and paged another.
 */
export function sortedBy(
  columns: SortColumns,
  request: SortRequest | null | undefined,
  idKey: OrderKey,
): SortedListing | null {
  const resolved = resolveSort(columns, request?.name, idKey);
  if (!resolved || !request) return null;

  const order = ordering(resolved.keys, request.dir);
  let after: string[] | null = null;
  if (request.cursor) {
    after = decodeSortCursor(request.cursor, resolved.name, request.dir, order.size);
    if (!after) {
      throw Object.assign(new Error("invalid cursor: not a cursor this ordering issued"), {
        statusCode: 400,
      });
    }
  }
  return { name: resolved.name, dir: request.dir, order, after };
}

export function resolveSort(
  columns: SortColumns,
  sort: string | undefined,
  idKey: OrderKey,
): { name: string; keys: OrderKey[] } | null {
  if (!sort) return null;
  const keys = columns[sort];
  if (!keys) {
    throw Object.assign(
      new Error(`cannot sort by ${sort}; try one of ${Object.keys(columns).sort().join(", ")}`),
      { statusCode: 400 },
    );
  }
  return { name: sort, keys: [...keys, idKey] };
}
