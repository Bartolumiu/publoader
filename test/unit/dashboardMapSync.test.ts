// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The two guards on the dashboard's series-map page: publishing it to GitHub,
 * and adding a mapping whose external id is already there.
 *
 * ---
 *
 * The series map can be pushed to GitHub from the dashboard.
 *
 * `POST /maps/sync` and `publoader-admin maps sync` both existed from the day
 * the weekly timer was written, but nothing on the dashboard called either. The
 * effect was not a missing convenience: an operator who repointed a series,
 * looked at the extensions repo and saw the old file had no way to tell a job
 * that runs every seven days from a job that is broken, and no way to settle it
 * without a shell. These tests pin the control that closed that gap.
 *
 * Driven the same way as dashboardOutstanding.test.ts: the real app.js
 * evaluated under jsdom against a stubbed API. See dashboardChapters.test.ts's
 * header for why app.js is a classic script and how it is mounted.
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
 * A report with one of every outcome that matters. `unchanged` and `skipped`
 * are successes, `refused` is the shrink guard doing its job; all three come
 * back with `failed: 0`, which is exactly why the card has to show the column
 * rather than a single verdict.
 */
const REPORT = {
  ok: true,
  ranAt: "2026-08-19T12:30:33.527Z",
  dryRun: true,
  written: 1,
  failed: 0,
  outcomes: [
    {
      extension: "mangaplus",
      status: "write",
      repo: "publoader-extensions",
      path: "src/mangaplus/manga_id_map.json",
      added: 3,
      removed: 0,
      mappings: 1034,
      detail: "would write",
    },
    {
      extension: "viz",
      status: "unchanged",
      repo: "publoader-extensions-private",
      path: "src/viz/manga_id_map.json",
      added: 0,
      removed: 0,
      mappings: 12,
    },
    {
      extension: "k_manga",
      status: "skipped",
      repo: "publoader-extensions-private",
      added: 4,
      removed: 0,
      mappings: 4,
      detail: "the file is not in the repo; create it once by hand and the sync will keep it current",
    },
  ],
};

const MD_A = "aaaaaaaa-0000-4000-8000-000000000001";
const MD_B = "bbbbbbbb-0000-4000-8000-000000000002";
const MD_C = "cccccccc-0000-4000-8000-000000000003";

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
    { match: /\/maps\/sync$/, body: REPORT },
    {
      match: /\/extensions\/[^/]+\/tracked$/,
      body: {
        tracked: [
          { mangaId: "100001", mdMangaId: MD_A, namespace: "", createdAt: "2026-08-01T00:00:00Z" },
          { mangaId: "709", mdMangaId: MD_B, namespace: "vizmanga", createdAt: "2026-08-01T00:00:00Z" },
        ],
      },
    },
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

/**
 * jsdom implements <dialog> as an element but not its modal methods, so the
 * real `showModal()` that `confirmDialog` calls throws asynchronously out of a
 * click handler; which vitest reports as an unhandled error and exits non-zero
 * even when the assertions pass. Stubbing the two methods to the `open`
 * attribute they set is enough here: these tests read the dialog's rendered
 * content and click its buttons, not its modality. Same shim as
 * dashboardChapters.test.ts.
 */
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

function mount(): void {
  const html = readFileSync(INDEX_HTML, "utf8");
  const body = html.split("<body>")[1]?.split("</body>")[0];
  if (!body) throw new Error("index.html has no <body>: the dashboard shell cannot be mounted");
  doc.body.innerHTML = body;
  win.location.hash = "";
  installFetch();
  stubDialogs();
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

const syncCalls = (): { path: string; method: string; body: any }[] =>
  calls.filter((c) => c.path.includes("/maps/sync"));

describe("the series map can be pushed to GitHub from the dashboard", () => {
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

  it("offers the run on the series-map index", async () => {
    await goto("#/tracked");
    const card = cardByTitle("Publish to GitHub");
    expect(card).toBeTruthy();
    expect(buttonLabelled(card, "Preview")).toBeTruthy();
    expect(buttonLabelled(card, "Sync now")).toBeTruthy();
    // The index still renders: the new card is an addition, not a replacement.
    expect(cardByTitle("Series map by extension")).toBeTruthy();
  });

  it("previews without writing anything", async () => {
    await goto("#/tracked");
    calls = [];
    buttonLabelled(cardByTitle("Publish to GitHub"), "Preview").click();
    await settle();

    expect(syncCalls()).toHaveLength(1);
    const [call] = syncCalls();
    expect(call?.method).toBe("POST");
    // The whole point of the preview: it must not be able to commit.
    expect(call?.body).toEqual({ dryRun: true, force: false, extensions: [] });
  });

  it("shows each extension's outcome rather than one verdict", async () => {
    await goto("#/tracked");
    buttonLabelled(cardByTitle("Publish to GitHub"), "Preview").click();
    await settle();

    const text = cardByTitle("Publish to GitHub").textContent;
    expect(text).toContain("mangaplus");
    expect(text).toContain("+3 -0");
    // `unchanged` and `skipped` are not failures, and hiding them would leave
    // an operator unable to tell "nothing to do" from "this one needs a file".
    expect(text).toContain("unchanged");
    expect(text).toContain("skipped");
    expect(text).toContain("the file is not in the repo");
    expect(text).toContain("Would write 1 file(s)");
  });

  it("asks before committing, and does not post if the operator backs out", async () => {
    await goto("#/tracked");
    calls = [];
    buttonLabelled(cardByTitle("Publish to GitHub"), "Sync now").click();
    await settle();

    // Nothing has been sent yet; the confirmation is in front of the request.
    expect(syncCalls()).toHaveLength(0);
    const modal = doc.getElementById("modal");
    expect(modal.textContent).toContain("repository other people read");

    buttonLabelled(modal, "Cancel").click();
    await settle();
    expect(syncCalls()).toHaveLength(0);
  });

  it("commits for real once confirmed", async () => {
    await goto("#/tracked");
    calls = [];
    buttonLabelled(cardByTitle("Publish to GitHub"), "Sync now").click();
    await settle();
    buttonLabelled(doc.getElementById("modal"), "Commit it").click();
    await settle();

    expect(syncCalls()).toHaveLength(1);
    expect(syncCalls()[0]?.body).toEqual({ dryRun: false, force: false, extensions: [] });
  });

  it("carries force through only when it is ticked", async () => {
    await goto("#/tracked");
    const card = cardByTitle("Publish to GitHub");
    const force = card.querySelector('input[type="checkbox"]');
    expect(force).toBeTruthy();
    force.checked = true;

    calls = [];
    buttonLabelled(card, "Preview").click();
    await settle();
    expect(syncCalls()[0]?.body.force).toBe(true);
  });

  it("scopes the run to one extension from that extension's map page", async () => {
    await goto("#/extensions/mangaplus/series-map");
    const card = cardByTitle("Publish to GitHub");
    expect(card).toBeTruthy();

    calls = [];
    buttonLabelled(card, "Preview").click();
    await settle();
    expect(syncCalls()[0]?.body.extensions).toEqual(["mangaplus"]);
  });

  it("disables the run for a credential that cannot write the map", async () => {
    // A CONTRIBUTOR may curate the map but must not publish it to a repo.
    scopes = ["tracked:append", "extensions:read"];
    mount();
    await settle(10);
    await goto("#/tracked");

    const card = cardByTitle("Publish to GitHub");
    expect(buttonLabelled(card, "Preview").disabled).toBe(true);
    expect(buttonLabelled(card, "Sync now").disabled).toBe(true);
    expect(card.textContent).toContain('needs the "tracked:write" scope');
  });
});

/**
 * Adding a mapping whose external id is already on the map.
 *
 * The button says "Add", but the endpoint behind it is a PUT, so an id that is
 * already mapped was repointed on the first click with nothing said. Repointing
 * is the edit with no visible consequence and a large invisible one: the series
 * carries on publishing and its chapters start landing on a different title. A
 * mistyped id could redirect a live series and look exactly like success.
 */
describe("adding a mapping that already exists asks first", () => {
  const addForm = () => {
    const id = doc.getElementById("tracked-manga-id");
    return {
      externalId: id,
      mdId: doc.getElementById("tracked-md-id"),
      namespace: doc.getElementById("tracked-namespace"),
      add: buttonLabelled(id.closest("section.card"), "Add mapping"),
    };
  };

  /** Only the writes; the view reloads the map with a GET on the same path. */
  const puts = (): { path: string; method: string; body: any }[] =>
    calls.filter((c) => c.method === "PUT" && c.path.includes("/tracked"));

  const fill = (externalId: string, mdId: string, namespace = ""): any => {
    const form = addForm();
    form.externalId.value = externalId;
    form.mdId.value = mdId;
    form.namespace.value = namespace;
    return form;
  };

  beforeEach(async () => {
    calls = [];
    scopes = ["*"];
    mount();
    await settle(10);
    await goto("#/extensions/mangaplus/series-map");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllTimers();
  });

  it("adds an id the map does not have without asking", async () => {
    calls = [];
    fill("100999", MD_C).add.click();
    await settle();

    expect(puts()).toHaveLength(1);
    expect(puts()[0]?.body).toEqual({ mangaId: "100999", mdMangaId: MD_C });
    expect(doc.getElementById("modal").hasAttribute("open")).toBe(false);
  });

  it("names the title an existing id is already mapped to, and holds the write", async () => {
    calls = [];
    fill("100001", MD_C).add.click();
    await settle();

    expect(puts()).toHaveLength(0);
    const modal = doc.getElementById("modal");
    expect(modal.textContent).toContain("already mapped");
    // The id it currently points at is the fact the operator needs to see.
    expect(modal.textContent).toContain(MD_A);
    expect(modal.textContent).toContain(MD_C);
  });

  it("writes nothing when the repoint is declined", async () => {
    calls = [];
    fill("100001", MD_C).add.click();
    await settle();
    buttonLabelled(doc.getElementById("modal"), "Cancel").click();
    await settle();

    expect(puts()).toHaveLength(0);
  });

  it("repoints once confirmed", async () => {
    calls = [];
    fill("100001", MD_C).add.click();
    await settle();
    buttonLabelled(doc.getElementById("modal"), "Repoint it").click();
    await settle();

    expect(puts()).toHaveLength(1);
    expect(puts()[0]?.body).toEqual({ mangaId: "100001", mdMangaId: MD_C });
  });

  it("treats the same id and the same title as nothing to do", async () => {
    calls = [];
    fill("100001", MD_A).add.click();
    await settle();

    // No dialog and no request: a write that changes nothing should not report
    // success as though it had.
    expect(puts()).toHaveLength(0);
    expect(doc.getElementById("modal").hasAttribute("open")).toBe(false);
  });

  it("matches on the catalogue too, so the same id in another one is new", async () => {
    calls = [];
    // 709 is mapped in vizmanga; the same id in shonenjump is a different
    // series and must not be mistaken for a repoint.
    fill("709", MD_C, "shonenjump").add.click();
    await settle();

    expect(puts()).toHaveLength(1);
    expect(puts()[0]?.body).toEqual({ mangaId: "709", mdMangaId: MD_C, namespace: "shonenjump" });
  });

  it("still catches the clash when the catalogue matches", async () => {
    calls = [];
    fill("709", MD_C, "vizmanga").add.click();
    await settle();

    expect(puts()).toHaveLength(0);
    expect(doc.getElementById("modal").textContent).toContain("vizmanga");
  });

  it("tells an append-only credential to stop rather than offering the repoint", async () => {
    scopes = ["tracked:append", "extensions:read", "tracked:read"];
    mount();
    await settle(10);
    await goto("#/extensions/mangaplus/series-map");

    calls = [];
    fill("100001", MD_C).add.click();
    await settle();

    // No dialog: a confirmed repoint would only come back 403.
    expect(doc.getElementById("modal").hasAttribute("open")).toBe(false);
    expect(puts()).toHaveLength(0);
  });
});
