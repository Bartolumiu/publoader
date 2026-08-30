// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The release pacing controls, global and per extension.
 *
 * Spreading a run's uploads across days is a setting an operator can read
 * backwards: every field is a cap, and a cap of 0 reads as "release nothing"
 * when it actually means "no limit". Getting that wrong on the global field is
 * not a mistake anyone notices from the queue — a run still queues everything
 * it decided either way, so the difference only shows up days later in what
 * MangaDex has. So the copy is pinned here alongside the wiring.
 *
 * The per-extension half has its own trap: the inputs are seeded from the
 * EFFECTIVE values, so an extension following the global shows the global's
 * numbers, and saving that form would pin them. Hence a test that an override
 * really does merge over the global, and one that "Follow global" clears with
 * an empty body rather than writing the numbers on screen back.
 *
 * Driven the same way as dashboardMapSync.test.ts: the real app.js evaluated
 * under jsdom against a stubbed API. See dashboardChapters.test.ts's header for
 * why app.js is a classic script and how it is mounted.
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
 * A global that is not the defaults, and one extension pinned to its own
 * `perDay`. Every number differs from every other so a field read out of the
 * wrong one is visible rather than accidentally correct.
 */
const SCHEDULE = {
  global: { perDay: 60, perMangaPerDay: 2, intervalHours: 12 },
  overrides: { viz: { perDay: 10 } },
  defaults: { perDay: 50, perMangaPerDay: 3, intervalHours: 24 },
};

/** Swapped per test so the scope gate can be exercised. */
let scopes: string[] = ["*"];
/** Every request app.js made, in order, with the body it sent. */
let calls: { path: string; method: string; body: any }[] = [];

function apiRoutes(): { match: RegExp; body: unknown }[] {
  return [
    { match: /\/session$/, body: { actor: "ardax", role: "OWNER", userId: "u1", email: "a@b.c" } },
    {
      match: /\/whoami$/,
      body: {
        kind: "session",
        name: "ardax",
        role: "OWNER",
        scopes,
        csrfHeader: "x-requested-with",
        csrfValue: "publoader-dash",
      },
    },
    {
      match: /\/stats$/,
      body: { paused: false, workers: {}, jobs: {}, uploadTasks: [], quarantined: 0 },
    },
    { match: /\/runs\?limit=1/, body: { runs: [] } },
    { match: /\/removal-mode$/, body: { mode: "DELETE", validModes: ["DELETE", "IGNORE"] } },
    {
      match: /\/fetch-throttle/,
      body: {
        global: { minIntervalMs: 500, jitter: true, jitterRatio: 0.5 },
        overrides: {},
        defaults: { minIntervalMs: 500, jitter: true, jitterRatio: 0.5 },
      },
    },
    { match: /\/upload-schedule/, body: SCHEDULE },
    { match: /\/extensions\/[^/]+\/config$/, body: { mangadexLanguages: ["en"], passthrough: {} } },
    { match: /\/extensions$/, body: { extensions: [{ name: "mangaplus" }, { name: "viz" }] } },
  ];
}

function installFetch(): void {
  const routes = apiRoutes();
  win.fetch = vi.fn(async (url: string, init: any = {}) => {
    const path = String(url);
    let body: any = null;
    try {
      body = init.body ? JSON.parse(init.body) : null;
    } catch {
      body = init.body;
    }
    calls.push({ path, method: init.method ?? "GET", body });
    const route = routes.find((r) => r.match.test(path));
    return {
      ok: Boolean(route),
      status: route ? 200 : 404,
      statusText: route ? "OK" : "Not Found",
      text: async () => JSON.stringify(route ? route.body : {}),
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
  installFetch();
  // Evaluated rather than imported: app.js is deliberately a classic script
  // ending in `void boot()`, so this is how a browser runs it. The source is
  // this repo's own file read from disk; nothing is interpolated into it.
  new Function(readFileSync(APP_JS, "utf8")).call(win);
}

/**
 * The most recently rendered card whose heading is `title`.
 *
 * Last, not first: every test in this file evaluates app.js again on the one
 * jsdom window, so earlier instances can leave their own nodes behind.
 */
function cardByTitle(title: string): any {
  const cards = [...doc.querySelectorAll("section.card")].filter(
    (c: any) => c.querySelector("h2")?.textContent === title,
  );
  return cards[cards.length - 1];
}

const buttonLabelled = (root: any, text: string): any =>
  [...root.querySelectorAll("button")].find((b: any) => b.textContent === text);

/** The card's three number inputs, in the order they are drawn. */
const numbers = (card: any): string[] =>
  [...card.querySelectorAll('input[type="number"]')].map((i: any) => i.value);

const scheduleWrites = (): { path: string; method: string; body: any }[] =>
  calls.filter((c) => c.method === "POST" && c.path.includes("/upload-schedule"));

describe("release pacing is editable from the dashboard", () => {
  beforeEach(async () => {
    calls = [];
    scopes = ["*"];
    mount();
    await settle(10);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllTimers();
  });

  it("shows the global schedule beside the fetch pacing it is not", async () => {
    await goto("#/extensions");
    const card = cardByTitle("Release pacing");
    expect(card).toBeTruthy();
    expect(numbers(card)).toEqual(["60", "2", "12"]);
    // An addition, not a replacement: the two pacing settings are different
    // things and the operator needs both on the page.
    expect(cardByTitle("Publisher fetch pacing")).toBeTruthy();
  });

  it("says what 0 does and that spreading never drops a chapter", async () => {
    await goto("#/extensions");
    const text = cardByTitle("Release pacing").textContent;
    // The two readings that would cost an operator real chapters if they took
    // the opposite one.
    expect(text).toContain("0 is no limit");
    expect(text).toContain("never whether it is");
  });

  it("names the extensions that will ignore the global", async () => {
    await goto("#/extensions");
    expect(cardByTitle("Release pacing").textContent).toContain("Overridden for: viz");
  });

  it("saves all three fields together", async () => {
    await goto("#/extensions");
    const card = cardByTitle("Release pacing");
    const [perDay, perManga, interval] = [...card.querySelectorAll('input[type="number"]')];
    perDay.value = "80";
    perManga.value = "0";
    interval.value = "6";

    calls = [];
    buttonLabelled(card, "Save").click();
    await settle();

    expect(scheduleWrites()).toHaveLength(1);
    const [write] = scheduleWrites();
    expect(write?.path).toContain("/upload-schedule");
    // 0 is sent as 0, not dropped as falsy: it is a value the endpoint accepts
    // and means something different from leaving the field alone.
    expect(write?.body).toEqual({ perDay: 80, perMangaPerDay: 0, intervalHours: 6 });
  });

  it("seeds an extension's form with what that extension actually uses", async () => {
    await goto("#/extensions/viz/config");
    const card = cardByTitle("Release pacing");
    expect(card).toBeTruthy();
    // perDay from the override, the other two from the global it merges over.
    expect(numbers(card)).toEqual(["10", "2", "12"]);
    expect(card.textContent).toContain("Overridden for viz");
  });

  it("clears an override with an empty body rather than the numbers on screen", async () => {
    await goto("#/extensions/viz/config");
    const card = cardByTitle("Release pacing");

    calls = [];
    buttonLabelled(card, "Follow global").click();
    await settle();

    expect(scheduleWrites()).toHaveLength(1);
    expect(scheduleWrites()[0]?.path).toContain("/upload-schedule/viz");
    // Not `{ perDay: 10, ... }`: writing the effective values back would pin
    // viz to today's global instead of letting it track tomorrow's.
    expect(scheduleWrites()[0]?.body).toEqual({});
  });

  it("offers no way to unfollow a global an extension is already following", async () => {
    await goto("#/extensions/mangaplus/config");
    const card = cardByTitle("Release pacing");
    expect(numbers(card)).toEqual(["60", "2", "12"]);
    expect(card.textContent).toContain("Following the global");
    expect(buttonLabelled(card, "Follow global")).toBeUndefined();
    expect(buttonLabelled(card, "Override")).toBeTruthy();
  });

  it("hides the card from a credential that cannot read settings", async () => {
    scopes = ["extensions:read", "runs:read"];
    mount();
    await settle(10);
    await goto("#/extensions");
    expect(cardByTitle("Release pacing")).toBeUndefined();
  });
});
