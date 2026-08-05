// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The three chapter views, actually rendered.
 *
 * `dashboard/app.js` is 7 000 lines of vanilla JavaScript that nothing
 * type-checks and — until this file — nothing executed. The server-side tests
 * assert it is *served*; `dashboardModules.test.ts` covers the two views that
 * live in their own ES modules. The shell itself, where a mistyped helper name
 * is a blank card and a green suite, had no coverage at all.
 *
 * So this drives the real file under jsdom against a stubbed API: sign in as an
 * owner, navigate to each new destination, and assert the chapters actually
 * appear. It is a smoke test by design — it proves the views mount, ask the
 * endpoints this branch added, and put the returned chapters on the page. It
 * deliberately does not assert layout.
 *
 * app.js is a classic script for exactly this reason (see its header comment):
 * jsdom cannot execute module scripts, so it is evaluated here the way a browser
 * would evaluate it.
 */

/* eslint-disable @typescript-eslint/no-explicit-any --
   The DOM lib is deliberately kept out of this program (see the same note in
   dashboardModules.test.ts), so the jsdom globals are loosely typed in this
   file only. */
const doc: any = (globalThis as any).document;
const win: any = globalThis;
/* eslint-enable @typescript-eslint/no-explicit-any */

// Resolved from the working directory, not from `import.meta.url`: under the
// jsdom environment that URL is an http one, and readFileSync wants a path.
const DASHBOARD = resolve(process.cwd(), "src/core/api/dashboard");
const APP_JS = join(DASHBOARD, "app.js");
const INDEX_HTML = join(DASHBOARD, "index.html");

const MD_CHAPTER = "1c2d3e4f-0000-4000-8000-000000000001";
const MD_MANGA = "9a1b1c1d-0000-4000-8000-000000000000";

/** Canned API responses, keyed by the path prefix the view requests. */
function apiRoutes(): { match: RegExp; body: unknown }[] {
  return [
    { match: /\/session$/, body: { actor: "ardax", role: "OWNER", userId: "u1", email: "a@b.c" } },
    {
      match: /\/whoami$/,
      body: { kind: "session", name: "ardax", role: "OWNER", scopes: ["*"], csrfHeader: "x-requested-with", csrfValue: "publoader-dash" },
    },
    { match: /\/stats$/, body: { paused: false, workers: {}, jobs: {}, uploadTasks: [] } },
    {
      match: /\/runs\?limit=1/,
      body: { runs: [{ id: "r1", extension: "mangaplus", state: "PROCESSED", createdAt: "2026-08-01T00:00:00Z" }] },
    },
    {
      match: /\/runs\?limit=50/,
      body: {
        runs: [
          {
            id: "r1",
            extension: "mangaplus",
            kind: "UPDATE",
            state: "PROCESSED",
            segmentsTotal: 1,
            triggeredBy: "scheduler",
            createdAt: "2026-08-01T00:00:00Z",
            error: null,
            chaptersFound: 41,
            chaptersSeen: 902,
          },
        ],
      },
    },
    {
      match: /\/runs\/r1\/chapters\/summary/,
      body: {
        run: { id: "r1", extension: "mangaplus" },
        set: "updated",
        segments: [{ jobId: "j1", segmentIndex: 0, segmentKey: "seg0", jobState: "SUCCEEDED", updated: 2, all: null, untrackedManga: 0, submittedAt: "2026-08-01T00:00:00Z" }],
        segmentsTotal: 1,
        segmentsReported: 1,
        complete: true,
        totals: { updated: 2, all: null, untrackedManga: 0 },
        byManga: [{ mdMangaId: MD_MANGA, mangaId: "m1", mangaName: "Sakamoto Days", count: 2 }],
        mangaTitles: 1,
        mangaCapped: false,
      },
    },
    {
      match: /\/runs\/r1\/chapters\?/,
      body: {
        run: { id: "r1", extension: "mangaplus", state: "PROCESSED" },
        set: "updated",
        total: 2,
        limit: 100,
        offset: 0,
        order: "segmentIndex,position",
        chapters: [
          {
            jobId: "j1",
            segmentIndex: 0,
            segmentKey: "seg0",
            position: 1,
            chapter: { mangaName: "Sakamoto Days", mdMangaId: MD_MANGA, chapterNumber: "142", chapterTitle: "The Duel", chapterLanguage: "en", chapterUrl: "https://example.test/1", mdChapterId: null },
          },
          {
            jobId: "j1",
            segmentIndex: 0,
            segmentKey: "seg0",
            position: 2,
            chapter: { mangaName: "Sakamoto Days", mdMangaId: MD_MANGA, chapterNumber: "143", chapterTitle: null, chapterLanguage: "en", mdChapterId: MD_CHAPTER },
          },
        ],
      },
    },
    {
      match: /\/runs\/r1$/,
      body: {
        run: {
          id: "r1",
          extension: "mangaplus",
          extensionVersion: "1.0.0",
          bundleSha256: "a".repeat(64),
          kind: "UPDATE",
          state: "PROCESSED",
          createdAt: "2026-08-01T00:00:00Z",
          jobs: [],
        },
      },
    },
    {
      match: /\/queues\/chapters/,
      body: {
        total: 2,
        limit: 100,
        nextCursor: null,
        order: "notBefore,createdAt,id",
        states: ["PENDING"],
        summary: [],
        chapters: [
          {
            id: "t1",
            kind: "UPLOAD",
            state: "PENDING",
            dedupeKey: "src-1|142|en",
            attempt: 0,
            maxAttempts: 5,
            notBefore: "2026-08-01T00:00:00Z",
            position: 1,
            mangaName: "Sakamoto Days",
            mdMangaId: MD_MANGA,
            chapterNumber: "142",
            chapterVolume: "17",
            chapterTitle: "The Duel",
            chapterLanguage: "en",
            mdChapterId: null,
            editPayload: null,
            pageCount: 18,
          },
          {
            id: "t2",
            kind: "EDIT",
            state: "PENDING",
            dedupeKey: MD_CHAPTER,
            attempt: 0,
            maxAttempts: 5,
            notBefore: "2026-08-01T00:01:00Z",
            position: 2,
            mangaName: "Sakamoto Days",
            mdMangaId: MD_MANGA,
            chapterNumber: "141",
            chapterTitle: "Old title",
            chapterLanguage: "en",
            mdChapterId: MD_CHAPTER,
            editPayload: { title: "Corrected title" },
            pageCount: 0,
          },
        ],
      },
    },
    { match: /\/chapters\/extensions/, body: { table: "uploaded", extensions: [{ extension: "mangaplus", count: 902 }] } },
    {
      match: new RegExp(`/chapters/${MD_CHAPTER}$`),
      body: {
        chapter: {
          mdChapterId: MD_CHAPTER,
          extensionName: "mangaplus",
          chapterNumber: "141",
          chapterVolume: "17",
          chapterTitle: "Old title",
          chapterLanguage: "en",
          mangaName: "Sakamoto Days",
          mdMangaId: MD_MANGA,
          mdGroupId: "4f1de6a2-f0c5-4ac5-bce5-02c7dbb67deb",
          imageArtifacts: [],
        },
        present: ["uploaded", "edited"],
        edits: [{ editedAt: "2026-07-01T00:00:00Z", old: { title: "Typo" }, new: { title: "Old title" } }],
        uploadedAt: "2026-06-01T00:00:00Z",
        updatedAt: "2026-07-01T00:00:00Z",
        lastEditedAt: "2026-07-01T00:00:00Z",
        unavailableAt: null,
        deletedAt: null,
        queued: [],
        mdFields: { volume: "17", chapter: "141", title: "Old title", translatedLanguage: "en", groups: ["4f1de6a2-f0c5-4ac5-bce5-02c7dbb67deb"] },
        editable: true,
      },
    },
    {
      match: /\/chapters\?/,
      body: {
        table: "uploaded",
        total: 1,
        limit: 50,
        offset: 0,
        tables: ["uploaded", "edited", "unavailable", "deleted"],
        chapters: [
          {
            mdChapterId: MD_CHAPTER,
            extensionName: "mangaplus",
            chapterNumber: "141",
            chapterVolume: "17",
            chapterTitle: "Old title",
            chapterLanguage: "en",
            mangaName: "Sakamoto Days",
            mdMangaId: MD_MANGA,
            at: "2026-07-01T00:00:00Z",
          },
        ],
      },
    },
  ];
}

/** Every path the stub was asked for, so a test can assert what a view fetched. */
let requested: string[] = [];

function installFetch(): void {
  const routes = apiRoutes();
  win.fetch = vi.fn(async (url: string) => {
    const path = String(url);
    requested.push(path);
    const route = routes.find((r) => r.match.test(path));
    const body = route ? route.body : {};
    return {
      // `ok` is what api() branches on; a stub without it makes every call throw
      // "200 OK" and the page falls back to the sign-in layer.
      ok: Boolean(route),
      status: route ? 200 : 404,
      statusText: route ? "OK" : "Not Found",
      text: async () => JSON.stringify(body),
    };
  });
}

/** Let the view's promises settle — resources fetch, then redraw. */
async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

const text = (): string => doc.getElementById("view").textContent ?? "";

async function goto(hash: string): Promise<void> {
  win.location.hash = hash;
  // jsdom fires hashchange asynchronously; app.js listens for it.
  await settle();
}

describe("dashboard chapter views", () => {
  beforeEach(async () => {
    requested = [];
    const html = readFileSync(INDEX_HTML, "utf8");
    // Body only: the <head> would pull app.js and style.css over the network,
    // and the script is evaluated by hand below. The markup is this repo's own
    // checked-in file, not input — this is the shipped page, which is the point.
    const body = html.split("<body>")[1]?.split("</body>")[0];
    if (!body) throw new Error("index.html has no <body>: the dashboard shell cannot be mounted");
    doc.body.innerHTML = body;
    win.location.hash = "";
    installFetch();

    // jsdom implements <dialog> as an element but not its modal methods, so the
    // real `showModal()` every dialog in app.js calls throws asynchronously out
    // of a click handler — which vitest reports as an unhandled error and exits
    // non-zero even though the assertions below pass. Stubbing the two methods
    // to the `open` attribute they set is enough for the tests here, which read
    // a dialog's rendered content rather than its modality.
    // Typed structurally rather than as HTMLDialogElement: this tsconfig's lib
    // is ES2023 with no DOM, which is why `win` above is `any` too.
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

    // Evaluated rather than imported. app.js is deliberately a classic script
    // (jsdom cannot execute module scripts) ending in `void boot()`, so this is
    // how a browser runs it and `boot()` is exactly the entry point under test.
    // The source is this repo's own file read from disk; nothing is interpolated
    // into it.
    new Function(readFileSync(APP_JS, "utf8")).call(win);
    await settle(10);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllTimers();
  });

  it("signs in and shows the new Chapters destination in the sidebar", () => {
    expect(doc.getElementById("app").hidden).toBe(false);
    expect(doc.getElementById("nav").textContent).toContain("Chapters");
  });

  it("shows how many chapters each run found, in the runs list", async () => {
    await goto("#/runs/recent");
    expect(text()).toContain("Chapters found");
    expect(text()).toContain("41");
    expect(text()).toContain("of 902 seen");
  });

  it("lists the chapters a run found, with the per-series breakdown", async () => {
    await goto("#/runs/r1");
    expect(requested.some((path) => path.includes("/runs/r1/chapters?"))).toBe(true);
    expect(requested.some((path) => path.includes("/runs/r1/chapters/summary"))).toBe(true);
    expect(text()).toContain("Chapters found");
    // The chapters themselves, not just the counts.
    expect(text()).toContain("The Duel");
    expect(text()).toContain("143");
    // And the coverage line that says the list can be trusted as whole.
    expect(text()).toContain("segments reported");
  });

  it("lists the queue as chapters, numbered in claim order", async () => {
    await goto("#/queues/chapters");
    expect(requested.some((path) => path.includes("/queues/chapters"))).toBe(true);
    const view = text();
    expect(view).toContain("Sakamoto Days");
    expect(view).toContain("142");
    // An EDIT row shows what it will change rather than the title it carries.
    expect(view).toContain("title → Corrected title");
    expect(view).toContain("claim order");
  });

  it("defaults the Queues page to the chapter view", async () => {
    await goto("#/queues");
    await settle();
    // The tab is resolved into the canonical hash, so a bookmark of `#/queues`
    // lands on the chapter list rather than the row list.
    expect(win.location.hash).toBe("#/queues/chapters");
  });

  it("browses the chapter archive and opens one chapter in full", async () => {
    await goto("#/chapters");
    expect(text()).toContain("Sakamoto Days");
    expect(text()).toContain("Old title");

    await goto(`#/chapters/${MD_CHAPTER}`);
    const view = text();
    expect(view).toContain("Edit metadata");
    expect(view).toContain("Edit history");
    // The archives this chapter appears in, and the history entry.
    expect(view).toContain("UPLOADED");
    expect(view).toContain("title → ");
  });

  it("opens the correction form prefilled with what MangaDex currently holds", async () => {
    await goto(`#/chapters/${MD_CHAPTER}`);
    const button = [...doc.querySelectorAll("button")].find((b: { textContent: string }) =>
      b.textContent === "Edit metadata",
    );
    expect(button).toBeTruthy();
    button.click();
    await settle();

    const dialog = doc.getElementById("modal-body");
    expect(dialog.textContent).toContain("does not change MangaDex directly");
    expect(doc.getElementById("md-edit-chapter").value).toBe("141");
    expect(doc.getElementById("md-edit-title").value).toBe("Old title");
    expect(doc.getElementById("md-edit-translatedLanguage").value).toBe("en");
  });

  it("sends only the fields that changed, as a MangaDex-shaped body", async () => {
    await goto(`#/chapters/${MD_CHAPTER}`);
    [...doc.querySelectorAll("button")]
      .find((b: { textContent: string }) => b.textContent === "Edit metadata")
      .click();
    await settle();

    doc.getElementById("md-edit-title").value = "Corrected title";
    [...doc.querySelectorAll("#modal-body button")]
      .find((b: { textContent: string }) => b.textContent === "Queue the correction")
      .click();
    await settle();

    const call = win.fetch.mock.calls.find(
      ([url]: [string]) => String(url).includes(`/chapters/${MD_CHAPTER}/edit`),
    );
    expect(call).toBeTruthy();
    expect(call[1].method).toBe("POST");
    // `volume` and `chapter` were left alone, so they are not in the body —
    // a form that submitted all four would write "unchanged" edits into the
    // chapter's permanent history.
    expect(JSON.parse(call[1].body)).toEqual({ title: "Corrected title" });
  });
});
