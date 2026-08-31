import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  decodeSortCursor,
  encodeSortCursor,
  numericTextKeys,
  ordering,
  plainKey,
  resolveSort,
  textKeys,
  timeKeys,
} from "../../src/core/store/ordering.js";

/**
 * The SQL a sorted, keyset-paged listing is built from.
 *
 * These assert the shape of the fragments rather than run them; the queries
 * themselves are exercised against a real Postgres in the integration suites,
 * which is where a claim about ordering can actually be proved. What is worth
 * pinning here is the part that is easy to get wrong by inspection and silent
 * when it is wrong: that every key is bound as a parameter rather than
 * interpolated, that the blank keys hold their direction while the value keys
 * flip, and that a cursor cannot be read back under a different ordering.
 */

const ID = plainKey(Prisma.sql`c.id`, "text")[0]!;

describe("ordering", () => {
  it("flips the value key with the direction and pins blanks to the bottom", () => {
    const keys = [...textKeys(Prisma.sql`c.manga_name`), ID];

    expect(ordering(keys, "asc").orderBy.sql).toBe(
      `(nullif(btrim(c.manga_name), '') IS NULL) ASC, coalesce(nullif(btrim(c.manga_name), ''), '') ASC, c.id ASC`,
    );
    // Descending reverses the values and the tiebreak, and leaves the blank key
    // alone: "the other end of this column", not "show me the empty rows".
    expect(ordering(keys, "desc").orderBy.sql).toBe(
      `(nullif(btrim(c.manga_name), '') IS NULL) ASC, coalesce(nullif(btrim(c.manga_name), ''), '') DESC, c.id DESC`,
    );
  });

  it("compares lexicographically, one strict step per key, all values bound", () => {
    const keys = [...textKeys(Prisma.sql`c.manga_name`), ID];
    const after = ordering(keys, "asc").after(["false", "Alpha", "row-1"])!;

    // Equal prefix then one strict comparison, for each key in turn.
    expect(after.sql.replaceAll(/\s+/g, " ")).toBe(
      "(((nullif(btrim(c.manga_name), '') IS NULL) > ?::boolean) OR " +
        "((nullif(btrim(c.manga_name), '') IS NULL) = ?::boolean AND " +
        "coalesce(nullif(btrim(c.manga_name), ''), '') > ?::text) OR " +
        "((nullif(btrim(c.manga_name), '') IS NULL) = ?::boolean AND " +
        "coalesce(nullif(btrim(c.manga_name), ''), '') = ?::text AND c.id > ?::text))",
    );
    expect(after.values).toEqual(["false", "false", "Alpha", "false", "Alpha", "row-1"]);
  });

  it("has no cursor predicate on the first page", () => {
    expect(ordering([ID], "asc").after(null)).toBeNull();
  });

  it("names its keys so a page's last row can be read back", () => {
    const order = ordering([...timeKeys(Prisma.sql`c.created_at`), ID], "desc");
    expect(order.select.sql).toContain(`AS "_sort0"`);
    expect(order.select.sql).toContain(`AS "_sort2"`);

    const at = new Date("2026-08-30T12:00:00.000Z");
    const row = { id: "row-1", _sort0: false, _sort1: at, _sort2: "row-1" };
    expect(order.cursorOf(row)).toEqual(["false", "2026-08-30T12:00:00.000Z", "row-1"]);
    // The aliases are plumbing; they must not reach the caller as data.
    expect(order.strip(row)).toEqual({ id: "row-1" });
  });

  it("orders a chapter number as a number, and anything unparseable as blank", () => {
    const [blank, value] = numericTextKeys(Prisma.sql`c.chapter_number`);
    expect(blank!.sql.sql).toContain("~ '^[0-9]+(\\.[0-9]+)?$'");
    expect(value!.cast).toBe("numeric");
  });
});

describe("sort cursors", () => {
  it("round-trips the key values", () => {
    const raw = encodeSortCursor("series", "asc", ["false", "a|b", "row-1"]);
    expect(decodeSortCursor(raw, "series", "asc", 3)).toEqual(["false", "a|b", "row-1"]);
  });

  it("refuses a cursor minted under another ordering", () => {
    const raw = encodeSortCursor("series", "asc", ["false", "Alpha", "row-1"]);
    expect(decodeSortCursor(raw, "state", "asc", 3)).toBeNull();
    expect(decodeSortCursor(raw, "series", "desc", 3)).toBeNull();
    expect(decodeSortCursor(raw, "series", "asc", 2)).toBeNull();
    expect(decodeSortCursor("not-a-cursor", "series", "asc", 3)).toBeNull();
  });
});

describe("resolveSort", () => {
  const columns = { series: textKeys(Prisma.sql`c.manga_name`), state: textKeys(Prisma.sql`c.state`) };

  it("is null when nothing was asked for", () => {
    expect(resolveSort(columns, undefined, ID)).toBeNull();
  });

  it("appends the id key, so the ordering is total", () => {
    expect(resolveSort(columns, "series", ID)!.keys).toHaveLength(3);
  });

  it("refuses an unknown column rather than quietly ignoring it", () => {
    expect(() => resolveSort(columns, "nonsense", ID)).toThrow(/cannot sort by nonsense/);
    expect(() => resolveSort(columns, "nonsense", ID)).toThrow(/series, state/);
  });
});
