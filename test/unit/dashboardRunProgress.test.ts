// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * What a run is doing while it is INGESTING.
 *
 * That state used to be a chip and nothing else. A run in it walks its titles
 * one at a time, a MangaDex request or two each, and the processor logs nothing
 * for a title that decided nothing — which is most of them on a clean sweep. So
 * the console showed the same unchanged row for minutes, and whether that meant
 * "working" or "wedged on one request" was not answerable without shell access
 * to the host.
 *
 * The two things this guards are the two different questions the row answers:
 * the counter is progress, and the AGE of the counter is whether there is any.
 * A heartbeat lands every 15s while the loop turns, so an old one on a run still
 * marked INGESTING is the stall itself — and it has to read as a warning rather
 * than as a stale-looking number nobody subtracts.
 */

/* eslint-disable @typescript-eslint/no-explicit-any --
   The DOM lib is deliberately out of this program; see dashboardModules.test.ts. */
const doc: any = (globalThis as any).document;
const win: any = globalThis;

const DASHBOARD = resolve(process.cwd(), "src/core/api/dashboard");
const APP_JS = join(DASHBOARD, "app.js");
const INDEX_HTML = join(DASHBOARD, "index.html");

let RUNS: any = null;

const run = (over: Record<string, unknown> = {}) => ({
  id: "11111111-2222-4333-8444-555555555555",
  extension: "comikey",
  kind: "CLEAN",
  state: "INGESTING",
  segmentsTotal: 1,
  triggeredBy: "user:ardax",
  createdAt: "2026-09-06T10:00:00.000Z",
  error: null,
  chaptersFound: null,
  chaptersSeen: null,
  titlesFound: null,
  untrackedManga: null,
  scoped: false,
  scopeMangaIds: [],
  progress: null,
  ...over,
});

const listing = (runs: unknown[]) => ({
  runs,
  total: runs.length,
  limit: 25,
  offset: 0,
  filters: { state: [], kind: [], scope: ["catalogue", "scoped"] },
});

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
    { match: /\/stats$/, body: { paused: false, workers: {}, jobs: {}, uploadTasks: [], quarantined: 0 } },
    { match: /\/extensions$/, body: { extensions: [{ name: "comikey" }] } },
    { match: /\/runs\?/, body: () => RUNS },
  ];
}

function installFetch(): void {
  const routes = apiRoutes();
  win.fetch = vi.fn(async (url: string) => {
    const path = String(url);
    const route = routes.find((r) => r.match.test(path));
    const raw = route ? route.body : {};
    return {
      ok: Boolean(route),
      status: route ? 200 : 404,
      statusText: route ? "OK" : "Not Found",
      text: async () => JSON.stringify(typeof raw === "function" ? (raw as () => unknown)() : raw),
    };
  });
}

async function settle(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

const text = (): string => doc.getElementById("view").textContent ?? "";

async function mount(): Promise<void> {
  const html = readFileSync(INDEX_HTML, "utf8");
  const body = html.split("<body>")[1]?.split("</body>")[0];
  if (!body) throw new Error("index.html has no <body>: the dashboard shell cannot be mounted");
  doc.body.innerHTML = body;
  win.location.hash = "";
  installFetch();
  new Function(readFileSync(APP_JS, "utf8")).call(win);
  await settle();
  win.location.hash = "#/runs";
  await settle();
}

describe("what a run reports while it is ingesting", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllTimers();
  });

  it("shows how far through its titles the run is", async () => {
    RUNS = listing([
      run({
        progress: {
          msg: "still processing run",
          at: new Date(Date.now() - 5_000).toISOString(),
          fields: { done: 412, total: 900, elapsedMs: 240_000, mangaId: "kengan-omega" },
        },
      }),
    ]);
    await mount();
    expect(text()).toContain("title 412 of 900");
  });

  it("calls a run that has stopped reporting stuck, rather than showing a stale count", async () => {
    RUNS = listing([
      run({
        progress: {
          msg: "still processing run",
          // Six beats missed. The loop reports every 15s while it turns.
          at: new Date(Date.now() - 6 * 60_000).toISOString(),
          fields: { done: 412, total: 900 },
        },
      }),
    ]);
    await mount();
    expect(text()).toContain("no progress for");
    expect(doc.querySelector(".warn-text")).toBeTruthy();
  });

  it("does not call a finished run stuck, however old its last line is", async () => {
    RUNS = listing([
      run({
        state: "PROCESSED",
        progress: {
          msg: "run processed",
          at: new Date(Date.now() - 6 * 3_600_000).toISOString(),
          fields: { visited: 900, upload: 12, elapsedMs: 252_000 },
        },
      }),
    ]);
    await mount();
    // How long it took is the question a finished run raises; "stuck" is not.
    expect(text()).toContain("processed in 4m 12s");
    expect(text()).not.toContain("no progress for");
  });

  it("says nothing at all for a run the processor has not reached", async () => {
    RUNS = listing([run({ state: "PENDING" })]);
    await mount();
    // The state cell, not the page: "Titles found" is a column header and
    // "named titles only" a filter option, so a text search over the whole view
    // would pass on chrome alone.
    const stateCell = [...doc.querySelectorAll("tbody tr td")][2];
    expect(stateCell.textContent).toBe("PENDING");
  });
});
