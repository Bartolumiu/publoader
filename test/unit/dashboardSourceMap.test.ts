// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Mapping a series from the publisher's own link.
 *
 * The card exists because every other mapping control starts by choosing an
 * extension, and "which extension covers this site" is one of the two facts an
 * operator arriving with a publisher link does not have — the other being what
 * that extension calls the series. Both are worked out from rows the platform
 * already holds, so these tests are mostly about what the card refuses to do
 * with a weak answer: it shows what it found, it leaves the id editable, and a
 * link landing on an already-mapped series is a repoint behind a confirmation.
 *
 * Driven like dashboardMapSync.test.ts: the real app.js evaluated under jsdom
 * against a stubbed API. See dashboardChapters.test.ts's header for why app.js
 * is a classic script and how it is mounted.
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

const TITLE_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER_ID = "bbbbbbbb-0000-4000-8000-000000000002";
const SOURCE = "https://comikey.com/comics/kengan-omega/";

/** The queue-row answer: the strongest one, and the common one. */
const queueMatch = {
  extension: "comikey",
  mangaId: "kengan-omega",
  namespace: null,
  via: "queue",
  untracked: { id: "u1", mangaName: "Kengan Omega", state: "NEW", mdMangaId: null },
  tracked: null,
};

/** Swapped per test: the card's whole job is reacting to what came back. */
let RESOLUTION: any = {
  url: SOURCE,
  normalised: "comikey.com/comics/kengan-omega",
  host: "comikey.com",
  candidates: ["comikey"],
  namespaces: [],
  match: queueMatch,
};
let MAP_RESULT: any = {
  ok: true,
  changed: true,
  outcome: "added",
  extension: "comikey",
  namespace: "",
  mangaId: "kengan-omega",
  mdMangaId: TITLE_ID,
  untrackedRow: "u1",
  resolution: { match: queueMatch },
};

/** The batch answer, swapped per test. Dry run and apply return the same shape. */
let BATCH: any = null;

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
    { match: /\/runs\?limit=1/, body: { runs: [] } },
    { match: /\/source\/resolve/, body: () => RESOLUTION },
    { match: /\/source\/map\/batch$/, body: () => BATCH },
    { match: /\/source\/map$/, body: () => MAP_RESULT },
    { match: /\/extensions\/[^/]+\/tracked$/, body: { tracked: [] } },
    { match: /\/extensions$/, body: { extensions: [{ name: "comikey" }] } },
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

async function settle(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

function mount(): void {
  const html = readFileSync(INDEX_HTML, "utf8");
  const body = html.split("<body>")[1]?.split("</body>")[0];
  if (!body) throw new Error("index.html has no <body>: the dashboard shell cannot be mounted");
  doc.body.innerHTML = body;
  win.location.hash = "";
  installFetch();
  stubDialogs();
  new Function(readFileSync(APP_JS, "utf8")).call(win);
}

async function goto(hash: string): Promise<void> {
  win.location.hash = hash;
  await settle();
}

/** The most recently rendered card with this heading; app.js is re-evaluated per test. */
function cardByTitle(title: string): any {
  const cards = [...doc.querySelectorAll("section.card")].filter(
    (c: any) => c.querySelector("h2")?.textContent === title,
  );
  return cards[cards.length - 1];
}

const buttonLabelled = (root: any, text: string): any =>
  [...root.querySelectorAll("button")].find((b: any) => b.textContent === text);

const mapCalls = () => calls.filter((c) => c.path.includes("/source/map"));

/** The card's three inputs, from the last-rendered copy of it. */
function fields(): any {
  const card = cardByTitle("Map a series from its links");
  expect(card, "the map-from-links card is not rendered").toBeTruthy();
  return {
    card,
    source: card.querySelector("#map-source"),
    mangaId: card.querySelector("#map-manga-id"),
    md: card.querySelector("#map-md"),
  };
}

/** A two-line paste that adds one series and cannot place the other. */
const batchReport = (over: Record<string, unknown> = {}) => ({
  dryRun: true,
  parseErrors: [],
  added: 1,
  updated: 0,
  unchanged: 0,
  failed: 0,
  unresolved: 1,
  closedQueueRows: 0,
  results: [
    {
      line: 1,
      sourceUrl: SOURCE,
      extension: "comikey",
      namespace: "",
      mangaId: "kengan-omega",
      mdMangaId: TITLE_ID,
      via: "queue",
      queued: "Kengan Omega",
      outcome: "added",
    },
    {
      line: 2,
      sourceUrl: "https://nobody-covers-this.example/series/1",
      extension: null,
      mdMangaId: OTHER_ID,
      outcome: "unresolved",
      detail: "no published extension declares nobody-covers-this.example in its allowed_hosts",
    },
  ],
  ...over,
});

describe("mapping many series from a pasted batch of links", () => {
  const batchCalls = () => calls.filter((c) => c.path.includes("/source/map/batch"));
  const bulk = () => {
    const card = cardByTitle("Map many from links");
    expect(card, "the map-many card is not rendered").toBeTruthy();
    return { card, text: card.querySelector("#map-many-text") };
  };

  beforeEach(async () => {
    calls = [];
    BATCH = batchReport();
    mount();
    await settle();
    await goto("#/tracked");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllTimers();
  });

  it("previews the whole paste as a dry run, and writes nothing", async () => {
    const b = bulk();
    b.text.value = `${SOURCE} ${TITLE_ID}\nhttps://nobody-covers-this.example/series/1 ${OTHER_ID}`;
    buttonLabelled(b.card, "Preview changes").click();
    await settle();

    expect(batchCalls()).toHaveLength(1);
    expect(batchCalls()[0]!.body.dryRun).toBe(true);
    // Every line's verdict is visible before anything is applied, including the
    // one that could not be placed — that is the whole point of pasting a batch.
    expect(b.card.textContent).toContain("kengan-omega");
    expect(b.card.textContent).toContain("added");
    expect(b.card.textContent).toContain("unresolved");
    expect(b.card.textContent).toContain("allowed_hosts");
  });

  it("only offers Apply once a preview has come back", async () => {
    const b = bulk();
    expect(buttonLabelled(b.card, "Apply; 1 added, 0 repointed")).toBeFalsy();

    b.text.value = `${SOURCE} ${TITLE_ID}`;
    buttonLabelled(b.card, "Preview changes").click();
    await settle();
    expect(buttonLabelled(b.card, "Apply; 1 added, 0 repointed")).toBeTruthy();
  });

  it("applies the same paste it previewed, without the dry run", async () => {
    const b = bulk();
    b.text.value = `${SOURCE} ${TITLE_ID}`;
    buttonLabelled(b.card, "Preview changes").click();
    await settle();

    BATCH = batchReport({ dryRun: false, closedQueueRows: 1 });
    buttonLabelled(b.card, "Apply; 1 added, 0 repointed").click();
    await settle();

    expect(batchCalls()).toHaveLength(2);
    expect(batchCalls()[1]!.body.dryRun).toBeUndefined();
    expect(batchCalls()[1]!.body.text).toContain(SOURCE);
    // What actually happened, including the queue rows that were closed.
    expect(b.card.textContent).toContain("queue row(s) closed");
    // The box is emptied so the same paste cannot be applied twice by accident.
    expect(b.text.value).toBe("");
  });

  it("says a paste that would change nothing has nothing to apply", async () => {
    BATCH = batchReport({ added: 0, unchanged: 1, unresolved: 0, results: [] });
    const b = bulk();
    b.text.value = `${SOURCE} ${TITLE_ID}`;
    buttonLabelled(b.card, "Preview changes").click();
    await settle();

    expect(b.card.textContent).toContain("nothing to apply");
    expect(buttonLabelled(b.card, "Apply; 0 added, 0 repointed")).toBeFalsy();
  });

  it("shows the lines it could not read at all, with their line numbers", async () => {
    BATCH = batchReport({
      parseErrors: [{ line: 2, text: "just-one-value", reason: "no publisher link on this line" }],
    });
    const b = bulk();
    b.text.value = `${SOURCE} ${TITLE_ID}\njust-one-value`;
    buttonLabelled(b.card, "Preview changes").click();
    await settle();

    expect(b.card.textContent).toContain("could not be read");
    expect(b.card.textContent).toContain("no publisher link on this line");
  });

  it("asks for something to paste rather than sending an empty batch", async () => {
    const b = bulk();
    buttonLabelled(b.card, "Preview changes").click();
    await settle();
    expect(batchCalls()).toHaveLength(0);
  });
});

describe("mapping a series from its publisher link", () => {
  beforeEach(async () => {
    calls = [];
    RESOLUTION = {
      url: SOURCE,
      normalised: "comikey.com/comics/kengan-omega",
      host: "comikey.com",
      candidates: ["comikey"],
      namespaces: [],
      match: queueMatch,
    };
    MAP_RESULT = {
      ok: true,
      changed: true,
      outcome: "added",
      extension: "comikey",
      namespace: "",
      mangaId: "kengan-omega",
      mdMangaId: TITLE_ID,
      untrackedRow: "u1",
      resolution: { match: queueMatch },
    };
    BATCH = batchReport();
    mount();
    await settle();
    await goto("#/tracked");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllTimers();
  });

  it("sits on the series-map index, where no extension has been chosen yet", () => {
    expect(cardByTitle("Map a series from its links")).toBeTruthy();
    // An addition, not a replacement.
    expect(cardByTitle("Series map by extension")).toBeTruthy();
  });

  it("works out the extension and the series, and says how it knows", async () => {
    const f = fields();
    f.source.value = SOURCE;
    buttonLabelled(f.card, "Look it up").click();
    await settle();

    const [call] = calls.filter((c) => c.path.includes("/source/resolve"));
    expect(String(call!.path)).toContain(encodeURIComponent(SOURCE));
    expect(f.card.textContent).toContain("comikey");
    expect(f.card.textContent).toContain("kengan-omega");
    // Which of the four answers it is, in words: a queue row and a measured
    // rule are not equally strong evidence.
    expect(f.card.textContent).toContain("untracked queue");
    expect(f.card.textContent).toContain("Kengan Omega");
    // The id it worked out is put where an operator can correct it.
    expect(f.mangaId.value).toBe("kengan-omega");
  });

  it("maps from the two links, sending the source url and the id out of the MangaDex link", async () => {
    const f = fields();
    f.source.value = SOURCE;
    buttonLabelled(f.card, "Look it up").click();
    await settle();

    f.md.value = `https://mangadex.org/title/${TITLE_ID}/kengan-omega`;
    buttonLabelled(f.card, "Map it").click();
    await settle();

    expect(mapCalls()).toHaveLength(1);
    expect(mapCalls()[0]!.method).toBe("POST");
    expect(mapCalls()[0]!.body).toEqual({ url: SOURCE, mdMangaId: TITLE_ID });
    // Closing the queue row is the step that would otherwise be forgotten.
    expect(cardByTitle("Map a series from its links").textContent).toContain("queue row was closed");
  });

  it("confirms before repointing a series that is already mapped", async () => {
    RESOLUTION = {
      ...RESOLUTION,
      match: { ...queueMatch, tracked: { mdMangaId: OTHER_ID, namespace: "", source: "operator:ardax" } },
    };
    const f = fields();
    f.source.value = SOURCE;
    buttonLabelled(f.card, "Look it up").click();
    await settle();
    // Said before the button is pressed, not only in the dialog afterwards.
    expect(f.card.textContent).toContain("already mapped");

    f.md.value = TITLE_ID;
    buttonLabelled(f.card, "Map it").click();
    await settle();
    expect(mapCalls()).toHaveLength(0);

    const modal = doc.getElementById("modal");
    expect(modal.textContent).toContain("already mapped");
    expect(modal.textContent).toContain(OTHER_ID);
    buttonLabelled(modal, "Repoint it").click();
    await settle();
    expect(mapCalls()).toHaveLength(1);
  });

  it("writes nothing when the repoint is declined", async () => {
    RESOLUTION = {
      ...RESOLUTION,
      match: { ...queueMatch, tracked: { mdMangaId: OTHER_ID, namespace: "", source: "operator:ardax" } },
    };
    const f = fields();
    f.source.value = SOURCE;
    buttonLabelled(f.card, "Look it up").click();
    await settle();
    f.md.value = TITLE_ID;
    buttonLabelled(f.card, "Map it").click();
    await settle();
    buttonLabelled(doc.getElementById("modal"), "Cancel").click();
    await settle();

    expect(mapCalls()).toHaveLength(0);
  });

  it("reports a link it cannot place, and refuses to map on it", async () => {
    RESOLUTION = {
      url: "https://unknown.example/x",
      normalised: "unknown.example/x",
      host: "unknown.example",
      candidates: [],
      namespaces: [],
      match: null,
      reason: "no published extension declares unknown.example in its allowed_hosts",
    };
    const f = fields();
    f.source.value = "https://unknown.example/x";
    buttonLabelled(f.card, "Look it up").click();
    await settle();
    expect(f.card.textContent).toContain("allowed_hosts");

    f.md.value = TITLE_ID;
    buttonLabelled(f.card, "Map it").click();
    await settle();
    expect(mapCalls()).toHaveLength(0);
  });

  it("asks for the series id when only the extension could be worked out", async () => {
    RESOLUTION = {
      ...RESOLUTION,
      match: { ...queueMatch, mangaId: null, via: "host", untracked: null },
    };
    const f = fields();
    f.source.value = SOURCE;
    buttonLabelled(f.card, "Look it up").click();
    await settle();
    expect(f.mangaId.value).toBe("");

    f.md.value = TITLE_ID;
    buttonLabelled(f.card, "Map it").click();
    await settle();
    // Half an answer must not become a guess at the other half.
    expect(mapCalls()).toHaveLength(0);

    // Typed in, it goes through — and travels as an explicit override.
    f.mangaId.value = "typed-by-hand";
    buttonLabelled(f.card, "Map it").click();
    await settle();
    expect(mapCalls()).toHaveLength(1);
    expect(mapCalls()[0]!.body).toEqual({
      url: SOURCE,
      mdMangaId: TITLE_ID,
      mangaId: "typed-by-hand",
    });
  });

  it("refuses a chapter link as the target before any request is made", async () => {
    const f = fields();
    f.source.value = SOURCE;
    buttonLabelled(f.card, "Look it up").click();
    await settle();

    f.md.value = `https://mangadex.org/chapter/${TITLE_ID}`;
    buttonLabelled(f.card, "Map it").click();
    await settle();
    expect(mapCalls()).toHaveLength(0);
  });
});
