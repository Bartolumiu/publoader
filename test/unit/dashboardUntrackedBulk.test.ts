// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Working the untracked queue in batches, and refusing the batch's one
 * genuinely dangerous member.
 *
 * The queue arrives in publisher-sized lumps — one run adds a catalogue — and
 * the answer for a whole catalogue is usually the same answer, so everything
 * here was previously several hundred clicks. That is not a slow way of doing
 * it; it is a reason it does not get done, and an untriaged queue is where the
 * duplicate MangaDex titles come from.
 *
 * The row to be careful about is the one whose series the SERIES MAP has
 * already answered while the row still reads NEW. It looks exactly like work to
 * do, and the work it looks like — Approve — creates a second title for a
 * series that already has one.
 *
 * Driven like the sibling dashboard tests: the real app.js evaluated under jsdom
 * against a stubbed API. See dashboardChapters.test.ts for why app.js is a
 * classic script and how it is mounted.
 */

/* eslint-disable @typescript-eslint/no-explicit-any --
   The DOM lib is deliberately kept out of this program (see dashboardModules.test.ts),
   so the jsdom globals and everything read back out of them are loosely typed here. */
const doc: any = (globalThis as any).document;
const win: any = globalThis;

const DASHBOARD = resolve(process.cwd(), "src/core/api/dashboard");
const APP_JS = join(DASHBOARD, "app.js");
const INDEX_HTML = join(DASHBOARD, "index.html");

const NEW_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const STALE_ID = "33333333-3333-4333-8333-333333333333";
const SKIPPED_ID = "44444444-4444-4444-8444-444444444444";
const TITLE_ID = "5f5f5f5f-0000-4000-8000-000000000001";
const MAPPED_TITLE = "5f5f5f5f-0000-4000-8000-000000000009";

const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: NEW_ID,
  extension: "opstest",
  mangaId: "ext-1",
  mangaName: "First Series",
  mangaLanguage: "en",
  mangaUrl: "https://example.com/series/1",
  state: "NEW",
  attempts: 0,
  mdMangaId: null,
  lastError: null,
  tracked: null,
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:00.000Z",
  ...over,
});

/** Two ordinary rows, one stale row, one skipped row. */
const QUEUE = () => ({
  untracked: [
    row(),
    row({ id: OTHER_ID, mangaId: "ext-2", mangaName: "Second Series", mangaUrl: "https://example.com/series/2" }),
    row({
      id: STALE_ID,
      mangaId: "ext-3",
      mangaName: "Third Series",
      // The row still reads NEW; the map says otherwise.
      tracked: { mdMangaId: MAPPED_TITLE, source: "operator:ardax", at: "2026-08-31T00:00:00.000Z" },
    }),
    row({ id: SKIPPED_ID, mangaId: "ext-4", mangaName: "Fourth Series", state: "SKIPPED" }),
  ],
  total: 4,
  limit: 50,
  nextCursor: null,
});

const TITLE = {
  id: TITLE_ID,
  title: "First Series",
  altTitles: ["A First Series"],
  url: `https://mangadex.org/title/${TITLE_ID}`,
  likely: true,
};

/** Swapped per test so one mount can answer a dry run and then a write. */
let SKIP_REPORT: any = { ok: true, skipped: 2, unchanged: [], missing: [] };
let UNSKIP_REPORT: any = null;
/** Ids whose approve should fail, and how. */
let APPROVE_FAILS: Record<string, string> = {};

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
        scopes: ["*"],
        csrfHeader: "x-requested-with",
        csrfValue: "publoader-dash",
      },
    },
    { match: /\/stats$/, body: { paused: false, workers: {}, jobs: {}, uploadTasks: [], quarantined: 0 } },
    { match: /\/mangadex\/title\//, body: { title: TITLE } },
    { match: /\/mangadex\/search/, body: { results: [TITLE] } },
    { match: /\/untracked\/automap$/, body: { ok: true, dryRun: true, mapped: [], considered: 0 } },
    { match: /\/untracked\/skip$/, body: () => SKIP_REPORT },
    { match: /\/untracked\/unskip$/, body: () => UNSKIP_REPORT },
    { match: /\/untracked\/[^/]+\/skip$/, body: { ok: true } },
    { match: /\/untracked\/[^/]+\/map$/, body: { ok: true, mdMangaId: TITLE_ID } },
    { match: /\/untracked\/[^/]+\/approve$/, body: { ok: true, mdMangaId: TITLE_ID } },
    { match: /\/extensions$/, body: { extensions: [{ name: "opstest" }] } },
    { match: /\/untracked\?/, body: () => QUEUE() },
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

    // Per-row approve is the one route a test needs to fail selectively: a
    // batch that reports "created 1 of 2" is only meaningful if the other one
    // actually failed.
    const approving = /\/untracked\/([^/]+)\/approve$/.exec(path);
    if (approving && APPROVE_FAILS[approving[1]!]) {
      return {
        ok: false,
        status: 409,
        statusText: "Conflict",
        text: async () => JSON.stringify({ error: APPROVE_FAILS[approving[1]!] }),
      };
    }

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

/** jsdom has <dialog> but not its modal methods; same shim as the sibling files. */
function stubDialogs(): void {
  interface DialogLike {
    showModal?: () => void;
    close?: () => void;
    setAttribute: (name: string, value: string) => void;
    removeAttribute: (name: string) => void;
  }
  const dialogs = win.HTMLDialogElement?.prototype as DialogLike | undefined;
  if (dialogs && typeof dialogs.showModal !== "function") {
    dialogs.showModal = function showModal(this: DialogLike): void {
      this.setAttribute("open", "");
    };
    dialogs.close = function close(this: DialogLike): void {
      this.removeAttribute("open");
    };
  }
}

async function settle(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

async function goto(hash: string): Promise<void> {
  win.location.hash = hash;
  await settle();
}

const text = (): string => doc.getElementById("view").textContent ?? "";

const buttonLabelled = (label: string, root: any = doc): any =>
  [...root.querySelectorAll("button")].find((b: any) => b.textContent === label);

const click = (label: string, root: any = doc): void => {
  const button = buttonLabelled(label, root);
  expect(button, `no button labelled ${label}`).toBeTruthy();
  button.click();
};

/** The <tr> whose series name is this one. */
function rowFor(name: string): any {
  const cell = [...doc.querySelectorAll("td")].find((td: any) => td.textContent?.includes(name));
  expect(cell, `no row for ${name}`).toBeTruthy();
  return cell.parentElement;
}

/** Tick the row whose series name is this one. */
function tick(name: string): void {
  const box = rowFor(name).querySelector('input[type="checkbox"]');
  expect(box, `row ${name} has no tick box`).toBeTruthy();
  box.checked = true;
  box.dispatchEvent(new win.Event("change"));
}

const callsTo = (fragment: string) => calls.filter((c) => c.path.includes(fragment));

describe("acting on many untracked rows at once", () => {
  beforeEach(async () => {
    calls = [];
    SKIP_REPORT = { ok: true, skipped: 2, unchanged: [], missing: [] };
    UNSKIP_REPORT = null;
    APPROVE_FAILS = {};
    const html = readFileSync(INDEX_HTML, "utf8");
    const body = html.split("<body>")[1]?.split("</body>")[0];
    if (!body) throw new Error("index.html has no <body>: the dashboard shell cannot be mounted");
    doc.body.innerHTML = body;
    win.location.hash = "";
    stubDialogs();
    installFetch();
    new Function(readFileSync(APP_JS, "utf8")).call(win);
    await settle();
    await goto("#/untracked");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllTimers();
  });

  it("says what the bar is for before anything is ticked", () => {
    expect(text()).toContain("Tick series to act on several at once");
    // The bulk control and the per-row one are not both called "Map…".
    expect(buttonLabelled("Map many…")).toBeTruthy();
    // Nothing is actionable yet, so nothing pretends to be.
    expect(buttonLabelled("Skip").disabled).toBe(true);
    expect(buttonLabelled("Unskip").disabled).toBe(true);
  });

  it("counts the selection and skips exactly the ticked rows", async () => {
    tick("First Series");
    tick("Second Series");
    await settle();
    expect(text()).toContain("2 selected");

    click("Skip");
    await settle();
    click("Skip 2");
    await settle();

    const [skip] = callsTo("/untracked/skip");
    expect(skip!.method).toBe("POST");
    expect(skip!.body.ids).toEqual([NEW_ID, OTHER_ID]);
    expect(text()).toContain("Skipped 2");
  });

  it("reports the rows a batch skip left alone rather than failing over them", async () => {
    SKIP_REPORT = {
      ok: true,
      skipped: 1,
      unchanged: [{ id: OTHER_ID, mangaName: "Second Series", state: "TRACKED" }],
      missing: [],
    };
    tick("First Series");
    tick("Second Series");
    await settle();
    click("Skip");
    await settle();
    click("Skip 2");
    await settle();

    expect(text()).toContain("Skipped 1");
    expect(text()).toContain("1 left alone");
  });

  it("previews an unskip against the server before putting anything back", async () => {
    UNSKIP_REPORT = {
      ok: true,
      dryRun: true,
      matched: 1,
      requeued: 1,
      alreadyTracked: [],
      series: [],
    };
    tick("Fourth Series");
    await settle();
    click("Unskip");
    await settle();

    // The dry run happened; nothing has been written.
    const previews = callsTo("/untracked/unskip");
    expect(previews).toHaveLength(1);
    expect(previews[0]!.body).toEqual({ ids: [SKIPPED_ID], dryRun: true });

    UNSKIP_REPORT = { ok: true, dryRun: false, matched: 1, requeued: 1, alreadyTracked: [], updated: 1 };
    click("Requeue 1");
    await settle();
    const all = callsTo("/untracked/unskip");
    expect(all).toHaveLength(2);
    expect(all[1]!.body).toEqual({ ids: [SKIPPED_ID], dryRun: false });
    expect(text()).toContain("back in the queue");
  });

  it("refuses an unskip the server says would duplicate a title, without asking", async () => {
    // A skipped row goes stale the moment the series is mapped by hand;
    // requeueing it is how a SECOND MangaDex title gets created for it.
    UNSKIP_REPORT = {
      ok: true,
      dryRun: true,
      matched: 1,
      requeued: 0,
      alreadyTracked: [{ id: SKIPPED_ID, mangaId: "ext-4", mangaName: "Fourth Series", mdMangaId: MAPPED_TITLE }],
      series: [],
    };
    tick("Fourth Series");
    await settle();
    click("Unskip");
    await settle();

    expect(callsTo("/untracked/unskip")).toHaveLength(1);
    expect(text()).toContain("already mapped");
    // No confirmation is offered for something that cannot be done.
    expect(buttonLabelled("Requeue 0")).toBeFalsy();
  });

  it("creates titles one at a time, and says which ones failed", async () => {
    APPROVE_FAILS = { [OTHER_ID]: "mangadex rejected the title" };
    tick("First Series");
    tick("Second Series");
    await settle();
    click("Approve…");
    await settle();
    click("Create 2 title(s)");
    await settle(30);

    // One request per row, not one batch: each is a write to MangaDex that
    // takes seconds, and forty behind one request is a timeout.
    expect(callsTo("/approve")).toHaveLength(2);
    expect(text()).toContain("Created 1 of 2");
    expect(text()).toContain("Second Series");
  });
});

describe("a queue row whose series the map has already answered", () => {
  beforeEach(async () => {
    calls = [];
    APPROVE_FAILS = {};
    const html = readFileSync(INDEX_HTML, "utf8");
    const body = html.split("<body>")[1]?.split("</body>")[0];
    if (!body) throw new Error("index.html has no <body>");
    doc.body.innerHTML = body;
    win.location.hash = "";
    stubDialogs();
    installFetch();
    new Function(readFileSync(APP_JS, "utf8")).call(win);
    await settle();
    await goto("#/untracked");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllTimers();
  });

  it("asks the server to leave them out of the listing by default", () => {
    const [listing] = calls.filter((c) => c.path.includes("/untracked?"));
    expect(String(listing!.path)).toContain("mapped=hide");
  });

  it("says so in words, and names the title, where one is shown", () => {
    expect(text()).toContain("already mapped");
    expect(text()).toContain("out of date");
  });

  it("refuses to create a title for one", () => {
    const approve = [...rowFor("Third Series").querySelectorAll("button")].find(
      (b: any) => b.textContent === "Approve",
    );
    expect(approve.disabled).toBe(true);
    expect(approve.title).toContain(MAPPED_TITLE);
  });

  it("keeps them out of a bulk approve rather than sending requests that will fail", async () => {
    tick("Third Series");
    await settle();
    // Ticked, counted — and not approvable, because the server would refuse it.
    expect(text()).toContain("1 selected");
    expect(buttonLabelled("Approve…").disabled).toBe(true);
  });
});

describe("mapping one queue row from the listing", () => {
  beforeEach(async () => {
    calls = [];
    APPROVE_FAILS = {};
    const html = readFileSync(INDEX_HTML, "utf8");
    const body = html.split("<body>")[1]?.split("</body>")[0];
    if (!body) throw new Error("index.html has no <body>");
    doc.body.innerHTML = body;
    win.location.hash = "";
    stubDialogs();
    installFetch();
    new Function(readFileSync(APP_JS, "utf8")).call(win);
    await settle();
    await goto("#/untracked");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllTimers();
  });

  it("reads the pasted title back before it will map anything", async () => {
    click("Map…", rowFor("First Series"));
    await settle();
    const modal = doc.getElementById("modal");
    expect(modal.textContent).toContain("First Series");

    // Nothing may be mapped on an unread id: a pasted uuid is exactly as easy
    // to get wrong as a name.
    expect(buttonLabelled("Map it", modal).disabled).toBe(true);

    modal.querySelector("#untracked-map-md").value = `https://mangadex.org/title/${TITLE_ID}`;
    click("Look it up", modal);
    await settle();

    expect(modal.textContent).toContain("A First Series");
    expect(buttonLabelled("Map it", modal).disabled).toBe(false);
    expect(callsTo("/map")).toHaveLength(0);

    click("Map it", modal);
    await settle();
    click("Map to this title");
    await settle();

    const [mapped] = callsTo(`/untracked/${NEW_ID}/map`);
    expect(mapped!.body).toEqual({ mdMangaId: TITLE_ID });
  });

  it("says what is wrong with a link that is not a MangaDex title", async () => {
    click("Map…", rowFor("First Series"));
    await settle();
    const modal = doc.getElementById("modal");
    modal.querySelector("#untracked-map-md").value = "https://example.com/series/1";
    click("Look it up", modal);
    await settle();

    expect(modal.textContent).toContain("not MangaDex");
    expect(callsTo("/mangadex/title/")).toHaveLength(0);
  });
});
