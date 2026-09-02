// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A table the server pages sorts the whole listing, not the page in hand.
 *
 * Clicking a column header on one of those tables is a request, not a reorder:
 * the rows on screen are one page of a queue that may be thousands deep, so
 * ordering them locally would answer "the first of these hundred" to a question
 * asked about all of them. What is checked here is that the click leaves as a
 * request — carrying the column, the direction, and no cursor — and that the
 * rows come back in whatever order the server put them in rather than being
 * reordered again on arrival.
 *
 * Driven the same way as dashboardTables.test.ts: the real app.js under jsdom
 * against a stubbed API, through real views.
 */

/* eslint-disable @typescript-eslint/no-explicit-any --
   The DOM lib is deliberately kept out of this program (see dashboardModules
   .test.ts); the jsdom globals are loosely typed in this file only. */
const doc: any = (globalThis as any).document;
const win: any = globalThis;

const DASHBOARD = resolve(process.cwd(), "src/core/api/dashboard");
const APP_JS = join(DASHBOARD, "app.js");
const INDEX_HTML = join(DASHBOARD, "index.html");

/**
 * Twenty-five queued tasks in an order no local sort would produce.
 *
 * The dedupe keys descend while the rows are listed, so a table that sorted
 * them in the browser would visibly reorder them; one that leaves the order
 * alone shows them exactly as served. That is the difference these tests turn
 * on, so the fixture never comes back sorted.
 */
const TASKS = Array.from({ length: 25 }, (_, i) => ({
  id: `task-${i}`,
  kind: "UPLOAD",
  state: "PENDING",
  dedupeKey: `omoi:chapter:${String(25 - i).padStart(2, "0")}`,
  attempt: 0,
  maxAttempts: 5,
  notBefore: new Date(Date.UTC(2026, 0, 2, 0, i)).toISOString(),
  lastError: null,
  identity: { chapterNumber: String(i + 1), chapterLanguage: "en" },
}));

const UNTRACKED = Array.from({ length: 25 }, (_, i) => ({
  id: `untracked-${i}`,
  extension: "omoi",
  mangaId: `src-${i}`,
  mangaName: `Series ${String(25 - i).padStart(2, "0")}`,
  mangaLanguage: "en",
  mangaUrl: `https://publisher.example/${i}`,
  state: "NEW",
  attempts: 0,
  lastError: null,
  mdMangaId: null,
}));

/** Every request app.js made, so a click can be checked for what it asked. */
let requests: string[] = [];

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
    { match: /\/extensions$/, body: { extensions: [{ name: "omoi" }] } },
    { match: /\/stats$/, body: { paused: false, workers: {}, jobs: {}, uploadTasks: [], quarantined: 0 } },
    { match: /\/queues\?/, body: { summary: [], total: 0 } },
    { match: /\/queues$/, body: { summary: [], total: 0 } },
    {
      match: /\/queues\/tasks/,
      body: {
        tasks: TASKS,
        total: 900,
        limit: 100,
        nextCursor: "cursor-two",
        summary: [],
        sortable: ["kind", "state", "chapter", "dedupeKey", "attempts", "notBefore", "lastError"],
      },
    },
    {
      match: /\/queues\/chapters/,
      body: { chapters: [], total: 0, limit: 100, nextCursor: null, summary: [] },
    },
    {
      match: /\/untracked\/extensions\?/,
      body: { state: "NEW", mapped: "hide", extensions: [{ extension: "opstest", count: 900 }], total: 900 },
    },
    {
      match: /\/untracked\?/,
      body: { untracked: UNTRACKED, total: 900, limit: 50, nextCursor: "cursor-two" },
    },
    { match: /\/runs\?limit=1/, body: { runs: [] } },
  ];
}

function installFetch(): void {
  const routes = apiRoutes();
  win.fetch = vi.fn(async (url: string) => {
    const path = String(url);
    requests.push(path);
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
  requests = [];
  installFetch();
  new Function(readFileSync(APP_JS, "utf8")).call(win);
}

function tableWith(header: string): any {
  return [...doc.querySelectorAll(".table-host")]
    .filter((host: any) => host.querySelector("thead tr")?.textContent?.includes(header))
    .at(-1);
}

const headerCell = (host: any, label: string): any =>
  [...host.querySelectorAll("thead th")].find((th: any) => th.textContent.includes(label));

const clickHeader = (host: any, label: string): void => {
  headerCell(host, label).querySelector("button.th-sort").click();
};

const bodyRows = (host: any): any[] => [...host.querySelectorAll("tbody tr")];
const columnText = (host: any, index: number): string[] =>
  bodyRows(host).map((tr: any) => tr.children[index].textContent.trim());

/** The last request made to a path, as parsed query parameters. */
function lastQuery(pattern: RegExp): URLSearchParams {
  const hit = [...requests].reverse().find((url) => pattern.test(url));
  if (!hit) throw new Error(`nothing requested matching ${pattern}`);
  return new URL(hit, "https://console.example").searchParams;
}

describe("a header on a server-paged table asks the server to order it", () => {
  beforeEach(async () => {
    mount();
    await settle(10);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllTimers();
  });

  it("sends the column and a direction rather than reordering the page", async () => {
    await goto("#/queues/tasks");
    const host = tableWith("Dedupe key");
    const before = columnText(host, 4);

    clickHeader(host, "Dedupe key");
    await settle();

    const query = lastQuery(/\/queues\/tasks/);
    expect(query.get("orderBy")).toBe("dedupeKey");
    expect(query.get("dir")).toBe("asc");
    // The stub answers with the same unsorted rows whatever is asked, so the
    // table showing them unchanged is the proof it did not sort them itself.
    expect(columnText(tableWith("Dedupe key"), 4)).toEqual(before);
  });

  it("reverses on a second press, and says so in aria-sort", async () => {
    await goto("#/queues/tasks");
    clickHeader(tableWith("Dedupe key"), "Dedupe key");
    await settle();

    let host = tableWith("Dedupe key");
    expect(headerCell(host, "Dedupe key").getAttribute("aria-sort")).toBe("ascending");

    clickHeader(host, "Dedupe key");
    await settle();

    host = tableWith("Dedupe key");
    expect(lastQuery(/\/queues\/tasks/).get("dir")).toBe("desc");
    expect(headerCell(host, "Dedupe key").getAttribute("aria-sort")).toBe("descending");
  });

  it("marks only the column doing the ordering", async () => {
    await goto("#/queues/tasks");
    clickHeader(tableWith("Dedupe key"), "Dedupe key");
    await settle();

    const host = tableWith("Dedupe key");
    const sorted = [...host.querySelectorAll("thead th")].filter(
      (th: any) => th.getAttribute("aria-sort") !== "none" && th.getAttribute("aria-sort") !== null,
    );
    expect(sorted).toHaveLength(1);
    expect(sorted[0]!.textContent).toContain("Dedupe key");
  });

  it("drops the cursors walked under the old ordering", async () => {
    await goto("#/queues/tasks");
    // Walk forward one page, so there is a cursor to lose. The server's pager,
    // "Next \u2192", not the table's own numbered "Next \u203a".
    const next = [...doc.querySelectorAll(".pager button")].find((b: any) =>
      b.textContent.includes("Next \u2192"),
    );
    expect(next).toBeTruthy();
    next.click();
    await settle();
    expect(lastQuery(/\/queues\/tasks/).get("cursor")).toBe("cursor-two");

    clickHeader(tableWith("Dedupe key"), "Kind");
    await settle();

    // A cursor names a row in the ordering that issued it; carried across, it
    // would page from nowhere in particular.
    const query = lastQuery(/\/queues\/tasks/);
    expect(query.get("cursor")).toBeNull();
    expect(query.get("orderBy")).toBe("kind");
  });

  it("never offers a column the server will not order by", async () => {
    await goto("#/queues/tasks");
    const host = tableWith("Dedupe key");
    // The leading checkbox column and the trailing button column: neither is a
    // column the server has, and neither is orderable anyway.
    const heads = [...host.querySelectorAll("thead th")];
    expect(heads[0]!.querySelector("button.th-sort")).toBeNull();
    expect(heads.at(-1)!.querySelector("button.th-sort")).toBeNull();
    // ...and every column that IS offered names one the endpoint accepts.
    const offered = heads.filter((th: any) => th.querySelector("button.th-sort")).length;
    expect(offered).toBe(7);
  });

  it("keeps the keyboard on the header that was pressed, across the refetch", async () => {
    await goto("#/queues/tasks");
    const button = headerCell(tableWith("Dedupe key"), "Dedupe key").querySelector("button.th-sort");
    button.focus();
    button.click();
    await settle();

    // The whole region is rebuilt around the answer, so this is a different
    // node than the one that was pressed; reversing a sort is a second press
    // of it, which is unusable if focus has gone back to the document.
    const focused = doc.activeElement;
    expect(focused.getAttribute("data-focus")).toBe(button.getAttribute("data-focus"));
    expect(focused.closest(".table-host")).toBe(tableWith("Dedupe key"));
  });

  it("does the same for the untracked queue", async () => {
    await goto("#/untracked");
    const host = tableWith("Attempts");
    clickHeader(host, "Series");
    await settle();

    // The listing, not the picker's counts: both live under /untracked, and
    // only one of them is ordered.
    const query = lastQuery(/\/untracked\?/);
    expect(query.get("orderBy")).toBe("series");
    expect(query.get("dir")).toBe("asc");
  });

});
