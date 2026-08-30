// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every table on the console pages at twenty rows and sorts on any column.
 *
 * The behaviour lives in one place, `table()` in app.js, which is what lets it
 * cover all forty-odd tables at once; these tests drive it through real views
 * (`#/runs`, whose table has a numeric column, a timestamp column and a column
 * that is often blank; `#/queues/tasks`, which has a column of buttons at each
 * end) rather than by reaching for the helper, because the helper is not
 * exported and because what matters is what an operator sees.
 *
 * Driven the same way as dashboardOutstanding.test.ts: the real app.js is
 * evaluated under jsdom against a stubbed API. See dashboardChapters.test.ts
 * for why app.js is a classic script and how it is mounted.
 */

/* eslint-disable @typescript-eslint/no-explicit-any --
   The DOM lib is deliberately kept out of this program (see the same note in
   dashboardModules.test.ts), so the jsdom globals, and every node read back out
   of them below, are loosely typed in this file only. */
const doc: any = (globalThis as any).document;
const win: any = globalThis;

const DASHBOARD = resolve(process.cwd(), "src/core/api/dashboard");
const APP_JS = join(DASHBOARD, "app.js");
const INDEX_HTML = join(DASHBOARD, "index.html");

/**
 * Forty-five runs: more than two pages, so the last page is a short one, and
 * with a segment count whose lexical order differs from its numeric order (2
 * sorts after 10 as text) so a numeric column can be caught being sorted as
 * strings. Every third run has no error, which is the blank case.
 *
 * The runs are a day apart rather than a minute, so they span three months: a
 * timestamp column sorted as text puts 1 February next to 1 January in a
 * day-first locale, and only dates that cross a month can catch that.
 */
const RUNS = Array.from({ length: 45 }, (_, i) => ({
  id: `run-${String(i).padStart(3, "0")}`,
  extension: `ext-${String(45 - i).padStart(2, "0")}`,
  kind: i % 2 ? "SCHEDULED" : "MANUAL",
  state: i % 5 === 0 ? "FAILED" : "SUCCEEDED",
  chaptersFound: i,
  chaptersSeen: i * 2,
  segmentsTotal: (i % 15) + 1,
  triggeredBy: "scheduler",
  // Noon, so the local calendar day is the same in every plausible timezone.
  createdAt: new Date(Date.UTC(2026, 0, 1 + i, 12)).toISOString(),
  error: i % 3 === 0 ? null : `boom ${i}`,
}));

/** Chronological order, which is `ext-45` first: the runs count downwards. */
const CHRONOLOGICAL = RUNS.map((run) => run.extension);

const EXTENSIONS = [{ name: "omoi" }, { name: "comikey" }, { name: "k_manga" }];

/**
 * Forty-five upload tasks, drawn with a leading checkbox column and a trailing
 * column of buttons: the two columns nothing can meaningfully be ordered by,
 * and enough rows that "select all on this page" has a page to be wrong about.
 */
const TASKS = Array.from({ length: 45 }, (_, i) => ({
  id: `task-${i}`,
  kind: "UPLOAD",
  state: "PENDING",
  dedupeKey: `omoi:chapter:${i}`,
  attempt: 0,
  maxAttempts: 5,
  notBefore: new Date(Date.UTC(2026, 0, 2, 0, i)).toISOString(),
  lastError: null,
  identity: { chapterNumber: String(i + 1), chapterLanguage: "en" },
}));

/**
 * Two hundred series mappings, which is ten pages.
 *
 * The needle "src-1" matches 111 of them — src-1, src-10 to src-19 and src-100
 * to src-199 — so the result is still six pages long. That matters: a result
 * that collapsed to one page would be forced back to page one by the clamp
 * alone, and would say nothing about whether the search resets it.
 */
const TRACKED = Array.from({ length: 200 }, (_, i) => ({
  mangaId: `src-${i}`,
  mdMangaId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  source: `https://example.test/series/${i}`,
  namespace: null,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
  runs: 0,
}));

function apiRoutes(): { match: RegExp; body: unknown }[] {
  return [
    { match: /\/session$/, body: { actor: "ardax", role: "OWNER", userId: "u1", email: "a@b.c" } },
    {
      match: /\/whoami$/,
      body: {
        kind: "session",
        name: "ardax",
        role: "OWNER",
        scopes: ["*"],
        csrfHeader: "x-requested-with",
        csrfValue: "publoader-dash",
      },
    },
    { match: /\/extensions$/, body: { extensions: EXTENSIONS } },
    { match: /\/runs\?limit=50/, body: { runs: RUNS } },
    { match: /\/runs\?limit=1/, body: { runs: [] } },
    { match: /\/stats$/, body: { paused: false, workers: {}, jobs: {}, uploadTasks: [], quarantined: 0 } },
    { match: /\/queues\?/, body: { summary: [], total: 0 } },
    { match: /\/queues$/, body: { summary: [], total: 0 } },
    {
      match: /\/queues\/tasks/,
      body: { tasks: TASKS, total: TASKS.length, limit: 100, nextCursor: null, summary: [] },
    },
    {
      match: /\/queues\/chapters/,
      body: { chapters: [], total: 0, limit: 100, nextCursor: null, summary: [] },
    },
    { match: /\/extensions\/[^/?]+\/tracked/, body: { tracked: TRACKED, namespaces: [] } },
    { match: /\/extensions\/[^/?]+$/, body: { extension: { name: "omoi" }, manifest: {} } },
    // Three rows: a table that fits on one page and must not grow a pager.
    {
      match: /\/dead-letter/,
      body: {
        jobs: Array.from({ length: 3 }, (_, i) => ({
          id: `job-${i}`,
          runId: `run-${i}`,
          extension: "omoi",
          errorClass: "TIMEOUT",
          attempt: 5,
          maxAttempts: 5,
          lastError: `gave up after ${i}`,
          updatedAt: new Date(Date.UTC(2026, 0, 2, 0, i)).toISOString(),
        })),
      },
    },
  ];
}

/** Set by a test to make one path answer something other than its fixture. */
let refuse: { match: RegExp; status: number; body: unknown } | null = null;

function installFetch(): void {
  const routes = apiRoutes();
  win.fetch = vi.fn(async (url: string) => {
    const path = String(url);
    if (refuse && refuse.match.test(path)) {
      return {
        ok: false,
        status: refuse.status,
        statusText: "Forbidden",
        text: async () => JSON.stringify(refuse!.body),
      };
    }
    const route = routes.find((r) => r.match.test(path));
    const body = route ? route.body : {};
    return {
      ok: Boolean(route),
      status: route ? 200 : 404,
      statusText: route ? "OK" : "Not Found",
      text: async () => JSON.stringify(body),
    };
  });
}

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

/** The series-map search waits for a pause in typing before it redraws. */
async function debounced(): Promise<void> {
  await new Promise((r) => setTimeout(r, 180));
  await settle();
}

async function goto(hash: string): Promise<void> {
  win.location.hash = hash;
  await settle();
}

function mount(): void {
  const html = readFileSync(INDEX_HTML, "utf8");
  const body = html.split("<body>")[1]?.split("</body>")[0];
  if (!body) throw new Error("index.html has no <body>: the dashboard shell cannot be mounted");
  doc.body.innerHTML = body;
  win.location.hash = "";
  installFetch();
  new Function(readFileSync(APP_JS, "utf8")).call(win);
}

/**
 * The table whose header row contains `header`.
 *
 * Every test in this file evaluates app.js again on the one jsdom window, so
 * earlier instances leave their nodes behind; the last match is the one the
 * current instance drew.
 */
function tableWith(header: string): any {
  return [...doc.querySelectorAll(".table-host")]
    .filter((host: any) => host.querySelector("thead tr")?.textContent?.includes(header))
    .at(-1);
}

const runsTable = (): any => tableWith("Triggered by");
const queueTable = (): any => tableWith("Dedupe key");

const bodyRows = (host: any): any[] => [...host.querySelectorAll("tbody tr")];

const columnText = (host: any, index: number): string[] =>
  bodyRows(host).map((tr: any) => tr.children[index].textContent.trim());

const headerCell = (host: any, label: string): any =>
  [...host.querySelectorAll("thead th")].find((th: any) => th.textContent.includes(label));

const clickHeader = (host: any, label: string): void => {
  headerCell(host, label).querySelector("button.th-sort").click();
};

const pageButtons = (host: any): string[] =>
  [...host.querySelectorAll(".page-numbers .page-n")].map((b: any) => b.textContent);

const goToPage = (host: any, number: string): void => {
  [...host.querySelectorAll(".page-n")].find((b: any) => b.textContent === number).click();
};

describe("every table pages at twenty rows with numbered pages", () => {
  beforeEach(async () => {
    mount();
    await settle(10);
  });

  afterEach(() => {
    refuse = null;
    vi.restoreAllMocks();
    vi.clearAllTimers();
  });

  it("draws only the first twenty of forty-five rows", async () => {
    await goto("#/runs");
    const host = runsTable();
    expect(host).toBeTruthy();
    expect(bodyRows(host).length).toBe(20);
    expect(host.querySelector(".page-count").textContent).toBe("1-20 of 45");
  });

  it("offers every page as a numbered destination, not just the next one", async () => {
    await goto("#/runs");
    expect(pageButtons(runsTable())).toEqual(["1", "2", "3"]);
    expect(runsTable().querySelector(".page-n.current").textContent).toBe("1");
  });

  it("walks to a numbered page, and the last page is the short one", async () => {
    await goto("#/runs");
    goToPage(runsTable(), "3");
    await settle();

    const host = runsTable();
    expect(bodyRows(host).length).toBe(5);
    expect(host.querySelector(".page-count").textContent).toBe("41-45 of 45");
    // The first row of page three is the forty-first run, in server order.
    expect(columnText(host, 0)[0]).toBe("ext-05");
  });

  it("caps the numbers it draws, however long the table is", async () => {
    await goto("#/runs");
    // First, last, the current page and two either side, with each remaining
    // run collapsed to an ellipsis: nine slots at the very most.
    expect(pageButtons(runsTable()).length).toBeLessThanOrEqual(9);
  });

  it("hides the pager when everything fits on one page", async () => {
    await goto("#/runs/dead-letter");
    const host = tableWith("Last error");
    expect(bodyRows(host).length).toBe(3);
    expect(host.querySelector(".table-pager")).toBeNull();
  });
});

describe("a table header is the sort control", () => {
  beforeEach(async () => {
    mount();
    await settle(10);
  });

  afterEach(() => {
    refuse = null;
    vi.restoreAllMocks();
    vi.clearAllTimers();
  });

  it("sorts a numeric column by value, not as text", async () => {
    await goto("#/runs");
    clickHeader(runsTable(), "Segments");
    await settle();

    // Segment counts run 1 to 15, three runs each, so page one ascending is
    // three of each of 1 to 6 and then two 7s.
    const shown = columnText(runsTable(), 4).map(Number);
    expect(shown).toEqual([...shown].sort((a, b) => a - b));
    expect(shown[0]).toBe(1);
    // The trap: sorted as text, "10" comes before "2", so this slot would hold
    // a 10 and the page would end in the teens rather than at 7.
    expect(shown[3]).toBe(2);
    expect(shown.at(-1)).toBe(7);
  });

  it("reverses on a second click and says so in aria-sort", async () => {
    await goto("#/runs");
    clickHeader(runsTable(), "Segments");
    await settle();
    expect(headerCell(runsTable(), "Segments").getAttribute("aria-sort")).toBe("ascending");

    clickHeader(runsTable(), "Segments");
    await settle();
    expect(headerCell(runsTable(), "Segments").getAttribute("aria-sort")).toBe("descending");
    expect(columnText(runsTable(), 4).map(Number)[0]).toBe(15);
  });

  it("marks only the column doing the ordering", async () => {
    await goto("#/runs");
    clickHeader(runsTable(), "Kind");
    await settle();

    const sorted = [...runsTable().querySelectorAll("th.sorted")];
    expect(sorted.length).toBe(1);
    expect(sorted[0].textContent).toContain("Kind");
    const others = [...runsTable().querySelectorAll("thead th:not(.sorted)")];
    expect(others.every((th: any) => th.getAttribute("aria-sort") === "none")).toBe(true);
  });

  it("sorts a timestamp column chronologically", async () => {
    await goto("#/runs");
    clickHeader(runsTable(), "Created");
    await settle();
    expect(columnText(runsTable(), 0)).toEqual(CHRONOLOGICAL.slice(0, 20));
  });

  /**
   * The one that bites outside the United States.
   *
   * `fmtTime` renders with `toLocaleString()`, and on an en-GB console that is
   * "05/02/2026, 12:00:00", which `Date.parse` refuses outright. Sorting the
   * column as text then orders it by day of the month — plausible-looking and
   * wrong. Both the formatter and the field-order probe are pinned to en-GB
   * here, which is what an operator outside the US actually has.
   */
  it("sorts a timestamp column chronologically in a day-first locale too", async () => {
    const realFormat = Intl.DateTimeFormat;
    const realToLocaleString = Date.prototype.toLocaleString;
    const Forced: any = function (locale: unknown, options: unknown) {
      return new realFormat((locale ?? "en-GB") as string, options as object);
    };
    Forced.prototype = realFormat.prototype;
    (Intl as any).DateTimeFormat = Forced;
    (Date.prototype as any).toLocaleString = function (this: Date, locale?: unknown, options?: unknown) {
      return realToLocaleString.call(this, (locale ?? "en-GB") as string, options as object);
    };

    try {
      // Remounted so the field-order probe, which runs once at load, sees en-GB.
      mount();
      await settle(10);
      await goto("#/runs");

      // Guard the guard: if this is not day-first, the test proves nothing.
      // Note what `Date.parse` does with these rather than that it refuses
      // them — "05/02/2026" comes back as the 2nd of May, not as NaN, and it is
      // that half-success the parser has to be kept away from.
      expect(columnText(runsTable(), 6)[0]).toMatch(/^\d{2}\/\d{2}\/\d{4}/);

      clickHeader(runsTable(), "Created");
      await settle();
      expect(columnText(runsTable(), 0)).toEqual(CHRONOLOGICAL.slice(0, 20));
    } finally {
      (Intl as any).DateTimeFormat = realFormat;
      (Date.prototype as any).toLocaleString = realToLocaleString;
    }
  });

  it("keeps blanks at the bottom in both directions", async () => {
    await goto("#/runs");
    // Every third run has no error, which renders as "-"; fifteen of the
    // forty-five, so a page of twenty would show some if they sorted first.
    clickHeader(runsTable(), "Error");
    await settle();
    expect(columnText(runsTable(), 7)).not.toContain("-");

    clickHeader(runsTable(), "Error");
    await settle();
    expect(columnText(runsTable(), 7)).not.toContain("-");
  });

  it("returns to the first page when the order changes", async () => {
    await goto("#/runs");
    goToPage(runsTable(), "3");
    await settle();
    expect(runsTable().querySelector(".page-n.current").textContent).toBe("3");

    clickHeader(runsTable(), "Kind");
    await settle();
    expect(runsTable().querySelector(".page-n.current").textContent).toBe("1");
  });

  it("holds the chosen order across a redraw, so a poll does not undo it", async () => {
    await goto("#/runs");
    clickHeader(runsTable(), "Segments");
    await settle();
    clickHeader(runsTable(), "Segments");
    await settle();

    // Leaving and coming back rebuilds the view from scratch, which is what a
    // poll does to the table; the operator's sort has to survive it.
    await goto("#/overview");
    await goto("#/runs");

    expect(headerCell(runsTable(), "Segments").getAttribute("aria-sort")).toBe("descending");
    expect(columnText(runsTable(), 4).map(Number)[0]).toBe(15);
  });

  it("never offers to sort a column of buttons", async () => {
    await goto("#/runs");
    // Runs is all data, so every one of its eight columns is sortable.
    expect(runsTable().querySelectorAll("thead th.sortable").length).toBe(8);

    await goto("#/queues/tasks");
    const host = queueTable();
    const headers = [...host.querySelectorAll("thead th")];
    expect(headers.length).toBe(9);
    expect(bodyRows(host).length).toBe(20);
    // The checkbox column and the action column are both blank-headed, and
    // ordering rows by the buttons in them means nothing; the other seven sort.
    expect(host.querySelectorAll("thead th.sortable").length).toBe(7);
    expect(headers[0].querySelector("button")).toBeNull();
    expect(headers.at(-1).querySelector("button")).toBeNull();
  });

  it("gives the stacked layout its own sort control, since the headers are hidden there", async () => {
    await goto("#/runs");
    const bar = runsTable().querySelector(".table-sortbar");
    expect(bar).toBeTruthy();

    const select = bar.querySelector("select");
    expect([...select.options].map((o: any) => o.textContent)).toEqual([
      "Unsorted",
      "Extension",
      "Kind",
      "State",
      "Chapters found",
      "Segments",
      "Triggered by",
      "Created",
      "Error",
    ]);

    select.value = "4";
    select.dispatchEvent(new win.Event("change"));
    await settle();
    expect(headerCell(runsTable(), "Segments").getAttribute("aria-sort")).toBe("ascending");
  });
});

describe("the table chrome is usable from the keyboard", () => {
  beforeEach(async () => {
    mount();
    await settle(10);
  });

  afterEach(() => {
    refuse = null;
    vi.restoreAllMocks();
    vi.clearAllTimers();
  });

  /**
   * Sorting and paging replace the whole table, including the control that was
   * just pressed. Without putting focus back, reversing a sort — which is by
   * design a second press on the same header — costs a keyboard operator a walk
   * back through the nav rail and twenty rows of links.
   */
  it("leaves focus on the header that was just pressed", async () => {
    await goto("#/runs");
    const button = headerCell(runsTable(), "Segments").querySelector("button.th-sort");
    button.focus();
    button.click();
    await settle();

    const active = doc.activeElement;
    expect(active.getAttribute("data-focus")).toBe("sort:4");
    expect(active.closest(".table-host")).toBe(runsTable());
  });

  it("leaves focus on the page number that was just pressed", async () => {
    await goto("#/runs");
    const two = [...runsTable().querySelectorAll(".page-n")].find((b: any) => b.textContent === "2");
    two.focus();
    two.click();
    await settle();
    expect(doc.activeElement.getAttribute("data-focus")).toBe("page:1");
  });

  it("moves focus off a step button that the last press disabled", async () => {
    await goto("#/runs");
    // Page two, then Next again: on the last page Next comes back disabled, so
    // focus has to land somewhere usable instead of falling back to <body>.
    goToPage(runsTable(), "2");
    await settle();
    const next = runsTable().querySelector('[data-focus="step:next"]');
    next.focus();
    next.click();
    await settle();

    const active = doc.activeElement;
    expect(active.tagName).not.toBe("BODY");
    expect(active.disabled).not.toBe(true);
    expect(active.closest(".table-host")).toBe(runsTable());
  });
});

describe("the controls stay honest about which rows are on the page", () => {
  beforeEach(async () => {
    mount();
    await settle(10);
  });

  afterEach(() => {
    refuse = null;
    vi.restoreAllMocks();
    vi.clearAllTimers();
  });

  /**
   * The one that could have deleted rows nobody saw.
   *
   * The queue fetches a batch of 100 and the table now draws 20 of it. "Select
   * all on this page" sits next to Remove, which deletes permanently, so if it
   * still meant "the batch" an operator could destroy eighty rows they were
   * never shown.
   */
  it("selects only the rows the table drew, not the batch behind them", async () => {
    await goto("#/queues/tasks");
    const host = queueTable();
    expect(bodyRows(host).length).toBe(20);

    const selectAll = [...doc.querySelectorAll("button")]
      .filter((b: any) => b.textContent === "Select all on this page")
      .at(-1);
    expect(selectAll).toBeTruthy();
    selectAll.click();
    await settle();

    const ticked = [...queueTable().querySelectorAll('tbody input[type="checkbox"]')].filter(
      (box: any) => box.checked,
    );
    // Twenty on screen, twenty ticked — not the 45 the server handed over.
    expect(ticked.length).toBe(20);
    expect(bodyRows(queueTable()).length).toBe(20);
  });

  it("does not call a fresh page 'all selected' because an earlier one was", async () => {
    await goto("#/queues/tasks");
    const label = () =>
      [...doc.querySelectorAll("button")]
        .map((b: any) => b.textContent)
        .filter((t: string) => t === "Select none" || t === "Select all on this page")
        .at(-1);

    [...doc.querySelectorAll("button")]
      .filter((b: any) => b.textContent === "Select all on this page")
      .at(-1)!
      .click();
    await settle();
    expect(label()).toBe("Select none");

    goToPage(queueTable(), "2");
    await settle();
    // Page two is untouched, so the button offers to select it, not to clear it.
    expect(label()).toBe("Select all on this page");
  });
});

describe("an extension filter is a picker over the extensions that exist", () => {
  beforeEach(async () => {
    mount();
    await settle(10);
  });

  afterEach(() => {
    refuse = null;
    vi.restoreAllMocks();
    vi.clearAllTimers();
  });

  const picker = (id: string): any => [...doc.querySelectorAll(`#${id}`)].at(-1);

  it("replaces the queue's typed extension box with the registry", async () => {
    await goto("#/queues/tasks");
    const select = picker("queue-extension");
    expect(select).toBeTruthy();
    expect(select.tagName).toBe("SELECT");
    expect([...select.options].map((o: any) => o.value)).toEqual(["", "comikey", "k_manga", "omoi"]);
  });

  it("does the same on the queue read as chapters", async () => {
    await goto("#/queues/chapters");
    const select = picker("queue-chapter-extension");
    expect(select.tagName).toBe("SELECT");
    expect([...select.options].map((o: any) => o.value)).toEqual(["", "comikey", "k_manga", "omoi"]);
  });

  it("narrows the queue to the chosen extension", async () => {
    await goto("#/queues/tasks");
    const select = picker("queue-extension");
    select.value = "omoi";
    select.dispatchEvent(new win.Event("change"));
    await settle();

    const asked = (win.fetch as any).mock.calls.map((c: any[]) => String(c[0]));
    expect(asked.some((url: string) => url.includes("extension=omoi"))).toBe(true);
  });

  it("gives the activity feed a picker too, where the filter used to be read-only", async () => {
    await goto("#/activity");
    const select = picker("activity-extension");
    expect(select).toBeTruthy();
    expect(select.tagName).toBe("SELECT");
  });

  it("asks the registry once, however many pickers a view draws", async () => {
    await goto("#/queues/tasks");
    await goto("#/queues/chapters");
    const asked = (win.fetch as any).mock.calls
      .map((c: any[]) => String(c[0]))
      .filter((url: string) => /\/extensions$/.test(url));
    expect(asked.length).toBe(1);
  });
});

describe("a filter typed into a table answers from the first page", () => {
  beforeEach(async () => {
    mount();
    await settle(10);
  });

  afterEach(() => {
    refuse = null;
    vi.restoreAllMocks();
    vi.clearAllTimers();
  });

  /**
   * The series map holds every mapping in the browser, so its search narrows
   * the rows under a table that keeps its own page number. Without a reset, an
   * operator on page four who searches is shown the fourth page of the matches
   * rather than the matches.
   */
  it("returns the series map to page one when the search changes", async () => {
    await goto("#/extensions/omoi/series-map");
    const map = () => tableWith("External id");
    expect(bodyRows(map()).length).toBe(20);
    expect(map().querySelector(".page-count").textContent).toBe("1-20 of 200");

    goToPage(map(), "3");
    await settle();
    expect(map().querySelector(".page-n.current").textContent).toBe("3");

    const search = [...doc.querySelectorAll("#tracked-search")].at(-1) as any;
    search.value = "src-1";
    search.dispatchEvent(new win.Event("input"));
    await debounced();

    // Still six pages, so nothing but the reset could have moved it off three.
    expect(map().querySelector(".page-count").textContent).toBe("1-20 of 111");
    expect(map().querySelector(".page-n.current").textContent).toBe("1");
  });

  it("keeps the chosen sort across that reset", async () => {
    await goto("#/extensions/omoi/series-map");
    const map = () => tableWith("External id");
    clickHeader(map(), "External id");
    await settle();
    clickHeader(map(), "External id");
    await settle();
    expect(headerCell(map(), "External id").getAttribute("aria-sort")).toBe("descending");

    const search = [...doc.querySelectorAll("#tracked-search")].at(-1) as any;
    search.value = "src-2";
    search.dispatchEvent(new win.Event("input"));
    await debounced();
    expect(headerCell(map(), "External id").getAttribute("aria-sort")).toBe("descending");
  });
});

describe("an extension filter the server will not describe", () => {
  afterEach(() => {
    refuse = null;
    vi.restoreAllMocks();
    vi.clearAllTimers();
  });

  /**
   * The queues are reached with `runs:read`, but the registry behind the picker
   * wants `extensions:read`. A narrowly scoped credential can be entitled to
   * filter by extension and not entitled to be told which ones exist; a picker
   * with nothing in it would take the filter away, so the typed box comes back.
   */
  it("falls back to a typed name rather than an empty picker", async () => {
    refuse = { match: /\/extensions$/, status: 403, body: { error: "missing scope: extensions:read" } };
    mount();
    await settle(10);
    await goto("#/queues/tasks");
    await settle(4);

    const control = [...doc.querySelectorAll("#queue-extension")].at(-1) as any;
    expect(control).toBeTruthy();
    expect(control.tagName).toBe("INPUT");
    expect(control.placeholder).toBe("exact name");
  });

  it("does not toast the missing scope, nor ask again on every redraw", async () => {
    refuse = { match: /\/extensions$/, status: 403, body: { error: "missing scope: extensions:read" } };
    mount();
    await settle(10);
    await goto("#/queues/tasks");
    await goto("#/queues/chapters");
    await goto("#/activity");
    await settle(4);

    expect(doc.querySelectorAll("#toasts .toast").length).toBe(0);
    const asked = (win.fetch as any).mock.calls
      .map((c: any[]) => String(c[0]))
      .filter((url: string) => /\/extensions$/.test(url));
    expect(asked.length).toBe(1);
  });
});
