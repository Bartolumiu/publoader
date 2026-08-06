// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The overview reads as work remaining, not work finished.
 *
 * A queue that has published forty thousand chapters and has four outstanding
 * ones used to render as forty thousand and four numbers of equal weight, with
 * the four that need an operator somewhere inside. These tests pin the rule
 * that fixed it: completed counts never occupy a tile, they live behind a
 * disclosure, and the tiles that remain are the way into the rows they count.
 *
 * Driven the same way as dashboardChapters.test.ts: the real app.js evaluated
 * under jsdom against a stubbed API. See that file's header for why app.js is a
 * classic script and how it is mounted.
 */

/* eslint-disable @typescript-eslint/no-explicit-any --
   The DOM lib is deliberately kept out of this program (see the same note in
   dashboardModules.test.ts), so the jsdom globals, and every node read back
   out of them below, are loosely typed in this file only. Not re-enabled: the
   element helpers further down are the same globals by another name. */
const doc: any = (globalThis as any).document;
const win: any = globalThis;

const DASHBOARD = resolve(process.cwd(), "src/core/api/dashboard");
const APP_JS = join(DASHBOARD, "app.js");
const INDEX_HTML = join(DASHBOARD, "index.html");

/**
 * A live instance in its normal state: a mountain of completed work, and a
 * handful of rows that still owe something. The numbers are lopsided on
 * purpose; that ratio is the whole reason these views were changed.
 */
const UPLOAD_DEPTHS = [
  { kind: "UPLOAD", state: "DONE", count: 40_120 },
  { kind: "UPLOAD", state: "PENDING", count: 3 },
  { kind: "EDIT", state: "DEAD_LETTER", count: 1 },
  { kind: "EDIT", state: "DONE", count: 8 },
  { kind: "DELETE", state: "DONE", count: 0 },
];

const JOB_COUNTS = { SUCCEEDED: 4021, CANCELLED: 2, PENDING: 5, DEAD_LETTER: 1 };

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
    {
      match: /\/stats$/,
      body: {
        paused: false,
        workers: { ACTIVE: 2 },
        jobs: JOB_COUNTS,
        uploadTasks: UPLOAD_DEPTHS,
        quarantined: 0,
      },
    },
    { match: /\/runs\?limit=1/, body: { runs: [] } },
    { match: /\/queues\?/, body: { summary: UPLOAD_DEPTHS, total: 40_132 } },
    { match: /\/queues$/, body: { summary: UPLOAD_DEPTHS, total: 40_132 } },
    {
      match: /\/queues\/tasks/,
      body: { tasks: [], total: 0, limit: 100, nextCursor: null, summary: UPLOAD_DEPTHS },
    },
    { match: /\/queues\/chapters/, body: { chapters: [], total: 0, limit: 100, nextCursor: null, summary: [] } },
  ];
}

let requested: string[] = [];

function installFetch(): void {
  const routes = apiRoutes();
  win.fetch = vi.fn(async (url: string) => {
    const path = String(url);
    requested.push(path);
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

async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

async function goto(hash: string): Promise<void> {
  win.location.hash = hash;
  await settle();
}

/** The rendered card whose heading is exactly `title`. */
function cardByTitle(title: string): any {
  const cards = [...doc.querySelectorAll("section.card")];
  return cards.find((c: any) => c.querySelector("h2")?.textContent === title);
}

/** The state chips drawn as tiles (not the ones inside a disclosure). */
function tileStates(card: any): string[] {
  const grid = card?.querySelector(".grid.tight");
  if (!grid) return [];
  return [...grid.querySelectorAll(".stat .chip")].map((chip: any) => chip.textContent);
}

describe("dashboard shows what is left, not what is done", () => {
  beforeEach(async () => {
    requested = [];
    const html = readFileSync(INDEX_HTML, "utf8");
    const body = html.split("<body>")[1]?.split("</body>")[0];
    if (!body) throw new Error("index.html has no <body>: the dashboard shell cannot be mounted");
    doc.body.innerHTML = body;
    win.location.hash = "";
    installFetch();
    new Function(readFileSync(APP_JS, "utf8")).call(win);
    await settle(10);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllTimers();
  });

  it("gives the overview's upload card tiles for outstanding work only", async () => {
    await goto("#/overview");
    const card = cardByTitle("Upload queue: outstanding");
    expect(card).toBeTruthy();

    // Worst first, and DONE is not among them.
    expect(tileStates(card)).toEqual(["DEAD_LETTER", "PENDING"]);
    expect(tileStates(card)).not.toContain("DONE");
  });

  it("folds the completed upload total into a disclosure, summed across kinds", async () => {
    await goto("#/overview");
    const details = cardByTitle("Upload queue: outstanding")?.querySelector("details");
    expect(details).toBeTruthy();
    // Closed by default: the operator opens it, it does not open on them.
    expect(details.hasAttribute("open")).toBe(false);
    expect(details.querySelector("summary").textContent).toBe(`Completed (${(40_128).toLocaleString()})`);
  });

  it("drops a kind whose only counts are zero", async () => {
    await goto("#/overview");
    const details = cardByTitle("Upload queue: outstanding")?.querySelector("details");
    // DELETE is DONE=0; neither a tile nor a completed row.
    expect(details.textContent).not.toContain("DELETE");
    expect(cardByTitle("Upload queue: outstanding").querySelector(".grid.tight").textContent).not.toContain("DELETE");
  });

  it("shows jobs the same way: open states as tiles, SUCCEEDED behind Settled", async () => {
    await goto("#/overview");
    const card = cardByTitle("Jobs outstanding");
    expect(card).toBeTruthy();
    expect(tileStates(card)).toEqual(["DEAD_LETTER", "PENDING"]);

    const summary = card.querySelector("details > summary");
    // SUCCEEDED 4021 + CANCELLED 2; both settled, neither actionable.
    expect(summary.textContent).toBe(`Settled (${(4023).toLocaleString()})`);
  });

  it("makes each depth tile a link into the rows it counts", async () => {
    await goto("#/queues/depth");
    const card = cardByTitle("Outstanding by kind and state");
    expect(card).toBeTruthy();

    const tiles = [...card.querySelectorAll("a.stat.linked")];
    expect(tiles.length).toBe(2);
    expect(tiles.every((t: any) => t.getAttribute("href") === "#/queues/tasks")).toBe(true);
  });

  it("carries the tile's kind and state into the Tasks list it opens", async () => {
    await goto("#/queues/depth");
    const tile = cardByTitle("Outstanding by kind and state").querySelector("a.stat.linked");
    // The DEAD_LETTER EDIT tile leads, because it is the one nothing will
    // retry on its own.
    tile.dispatchEvent(new win.Event("click", { bubbles: true }));
    await settle();

    requested = [];
    await goto("#/queues/tasks");

    // `some`, not the first match: every test in this file evaluates app.js
    // again on the one jsdom window, so each earlier instance still holds a
    // hashchange listener and refetches with its own (unfiltered) store. The
    // instance under test is the last to render and the last to ask, so the
    // assertion is that the filtered request was made, not that it was first.
    const asked = requested.filter((p) => p.includes("/queues/tasks"));
    expect(asked.some((p) => p.includes("kind=EDIT") && p.includes("state=DEAD_LETTER"))).toBe(true);
  });
});
