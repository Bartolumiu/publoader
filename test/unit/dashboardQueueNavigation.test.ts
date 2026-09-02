// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Getting from a number on screen to the rows behind it.
 *
 * Four things the console got wrong about a deep queue, all of them only
 * visible once one existed: the list opened at the far end of the claim order,
 * the completed counts were dead text, the page size was fixed at 100 with no
 * way through 31,000 rows, and "jobs in flight" counted job states that do not
 * exist. Driven through the real app.js under jsdom, like the other dashboard
 * suites; see dashboardTables.test.ts for why it is evaluated as a script.
 */

/* eslint-disable @typescript-eslint/no-explicit-any --
   The DOM lib is deliberately kept out of this program, so jsdom globals and
   the nodes read out of them are loosely typed in this file only. */
const doc: any = (globalThis as any).document;
const win: any = globalThis;

const DASHBOARD = resolve(process.cwd(), "src/core/api/dashboard");
const APP_JS = join(DASHBOARD, "app.js");
const INDEX_HTML = join(DASHBOARD, "index.html");

const TASKS = Array.from({ length: 3 }, (_, i) => ({
  id: `task-${i}`,
  kind: "UPLOAD",
  state: "PENDING",
  dedupeKey: `mangaup_global:chapter:${i}`,
  attempt: 0,
  maxAttempts: 5,
  notBefore: new Date(Date.UTC(2026, 0, 2, 0, i)).toISOString(),
  lastError: null,
  identity: { chapterNumber: String(i + 1), chapterLanguage: "en" },
}));

/** The depth summary: outstanding UPLOADs plus five kinds of completed work. */
const SUMMARY = [
  { kind: "UPLOAD", state: "PENDING", count: 31867 },
  { kind: "DELETE", state: "DONE", count: 1264 },
  { kind: "EDIT", state: "DONE", count: 3797 },
  { kind: "RESTORE", state: "DONE", count: 39 },
  { kind: "UNAVAILABLE", state: "DONE", count: 4492 },
  { kind: "UPLOAD", state: "DONE", count: 9638 },
];

let sent: { url: string; method: string }[] = [];
/** Overridden by a test that needs a different /stats body. */
let stats: Record<string, unknown> = {
  paused: false,
  workers: { ACTIVE: 4 },
  jobs: {},
  uploadTasks: [],
  quarantined: 0,
};

function installFetch(): void {
  sent = [];
  win.fetch = vi.fn(async (url: string, init?: any) => {
    const path = String(url);
    sent.push({ url: path, method: init?.method ?? "GET" });
    const route = (body: unknown) => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify(body),
    });
    if (/\/session$/.test(path)) {
      return route({ actor: "ardax", role: "OWNER", userId: "u1", email: "a@b.c" });
    }
    if (/\/whoami$/.test(path)) {
      return route({
        kind: "session",
        name: "ardax",
        role: "OWNER",
        scopes: ["*"],
        csrfHeader: "x-requested-with",
        csrfValue: "publoader-dash",
      });
    }
    if (/\/queues\/tasks/.test(path)) {
      return route({
        tasks: TASKS,
        total: TASKS.length,
        limit: 100,
        nextCursor: null,
        summary: SUMMARY,
      });
    }
    if (/\/queues/.test(path)) return route({ summary: SUMMARY, total: 51092 });
    if (/\/stats$/.test(path)) return route(stats);
    if (/\/runs/.test(path)) return route({ runs: [] });
    if (/\/extensions$/.test(path)) return route({ extensions: [{ name: "mangaup_global" }] });
    return route({});
  });
}

async function settle(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

function mount(): void {
  const html = readFileSync(INDEX_HTML, "utf8");
  const body = html.split("<body>")[1]?.split("</body>")[0];
  if (!body) throw new Error("index.html has no <body>: the dashboard shell cannot be mounted");
  doc.body.innerHTML = body;
  win.location.hash = "";
  installFetch();
  // The source is this repo's own file read from disk; nothing is interpolated.
  new Function(readFileSync(APP_JS, "utf8")).call(win);
}

const taskFetches = (): string[] =>
  sent.filter((r) => r.method === "GET" && /\/queues\/tasks/.test(r.url)).map((r) => r.url);

describe("getting from a number to the rows behind it", () => {
  beforeEach(async () => {
    stats = { paused: false, workers: { ACTIVE: 4 }, jobs: {}, uploadTasks: [], quarantined: 0 };
    mount();
    await settle();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllTimers();
  });

  it("opens the queue at what drains next, not at the far end", async () => {
    win.location.hash = "#/queues/tasks";
    await settle();
    const fetched = taskFetches();
    expect(fetched.length).toBeGreaterThan(0);
    // `desc` put the rows that run six weeks from now on the first page.
    for (const url of fetched) expect(url).toContain("sort=asc");
    expect(fetched.some((u) => u.includes("sort=desc"))).toBe(false);
  });

  it("asks for 100 rows by default and honours a larger page size", async () => {
    win.location.hash = "#/queues/tasks";
    await settle();
    expect(taskFetches().at(-1)).toContain("limit=100");

    const picker = [...doc.querySelectorAll("#queue-limit")].at(-1) as any;
    expect(picker).toBeTruthy();
    expect([...picker.options].map((o: any) => o.value)).toEqual(["100", "250", "500"]);

    picker.value = "500";
    picker.dispatchEvent(new win.Event("change"));
    await settle();
    // 500 is the route's own cap; offering more would turn a page press into a 400.
    expect(taskFetches().at(-1)).toContain("limit=500");
  });

  it("counts a queued job as in flight", async () => {
    // The list used to read QUEUED/EXECUTING/INGESTING, which are RunState
    // values or nothing at all. PENDING is the job state a backlog sits in, and
    // it was the one being dropped — so this read 0 while jobs piled up.
    stats = {
      paused: false,
      workers: { ACTIVE: 4 },
      jobs: { PENDING: 7, LEASED: 2, RUNNING: 1, SUCCEEDED: 327 },
      uploadTasks: [],
      quarantined: 0,
    };
    mount();
    await settle();
    expect(doc.getElementById("sum-jobs").textContent).toBe("10");
  });

  it("does not count settled jobs as in flight", async () => {
    stats = {
      paused: false,
      workers: { ACTIVE: 4 },
      jobs: { SUCCEEDED: 327, DEAD_LETTER: 13, CANCELLED: 1 },
      uploadTasks: [],
      quarantined: 0,
    };
    mount();
    await settle();
    expect(doc.getElementById("sum-jobs").textContent).toBe("0");
  });

  it("makes the jobs count a link", async () => {
    const link = doc.getElementById("sum-jobs-link");
    expect(link).toBeTruthy();
    expect(link.getAttribute("href")).toBeTruthy();
    expect(link.hasAttribute("aria-disabled")).toBe(false);
  });

  it("makes every completed row open its own rows", async () => {
    win.location.hash = "#/queues/depth";
    await settle();
    const links = [...doc.querySelectorAll("a")].filter((a: any) =>
      (a.getAttribute("title") ?? "").startsWith("Open the"),
    );
    const completed = links.filter((a: any) =>
      (a.getAttribute("title") ?? "").includes("completed"),
    );
    // Five completed kinds, each linked on both its name and its count.
    expect(completed.length).toBe(10);
    expect(completed.some((a: any) => a.textContent.trim() === "UPLOAD")).toBe(true);
    expect(completed.some((a: any) => a.textContent.trim() === "9638")).toBe(true);

    (completed.find((a: any) => a.textContent.trim() === "9638") as any).click();
    await settle();
    // Filtered to that exact cell, not merely to the kind.
    const last = taskFetches().at(-1) ?? "";
    expect(last).toContain("kind=UPLOAD");
    expect(last).toContain("state=DONE");
  });
});
