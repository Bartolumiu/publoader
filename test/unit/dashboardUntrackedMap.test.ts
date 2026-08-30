// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Mapping an untracked series onto a MangaDex title that already exists.
 *
 * Most series a scraper reports as untracked are already on MangaDex under a
 * name that did not match automatically. Approving creates a second title for
 * them, and un-duplicating a catalogue afterwards is other people's work — so
 * the search-and-map path has to be no more effort than the approve button
 * beside it, or it does not get used and the duplicates keep arriving.
 *
 * Driven the same way as dashboardChapters.test.ts: the real app.js evaluated
 * under jsdom against a stubbed API. See that file's header for why app.js is a
 * classic script and how it is mounted.
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

const ROW_ID = "11111111-1111-4111-8111-111111111111";
const MATCH_ID = "5f5f5f5f-0000-4000-8000-000000000001";
const OTHER_ID = "5f5f5f5f-0000-4000-8000-000000000002";

const ROW = {
  id: ROW_ID,
  extension: "opstest",
  mangaId: "ext-42",
  mangaName: "Mangled Nmae",
  mangaLanguage: "en",
  mangaUrl: "https://example.com/series/1",
  state: "NEW",
  attempts: 0,
  mdMangaId: null,
  lastError: null,
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:00.000Z",
};

const SEARCH_RESULTS = [
  {
    id: MATCH_ID,
    title: "Mangled Nmae",
    altTitles: ["A Mangled Name"],
    url: `https://mangadex.org/title/${MATCH_ID}`,
    likely: true,
  },
  {
    id: OTHER_ID,
    title: "Something Else",
    altTitles: [],
    url: `https://mangadex.org/title/${OTHER_ID}`,
    likely: false,
  },
];

const MAPPED_ROW = {
  id: ROW_ID,
  extension: "opstest",
  mangaName: "Mangled Nmae",
  mangaUrl: "https://example.com/series/1",
  mdMangaId: MATCH_ID,
  titleUrl: `https://mangadex.org/title/${MATCH_ID}`,
};

/** The dry-run report, rebuilt per test so a swap cannot leak into the next. */
const previewReport = () => ({
  ok: true,
  dryRun: true,
  strategy: "link",
  considered: 25,
  ambiguous: 1,
  unmatched: 22,
  remaining: 1987,
  mapped: [MAPPED_ROW],
});

/** Swapped by the commit test so one mount can answer a dry run, then a write. */
let AUTOMAP_REPORT: unknown = previewReport();

/** One page of the queue; the count is what tells the pager there is more. */
const queuePage = () => ({ untracked: [ROW], total: 2243, limit: 50, nextCursor: "cursor-page-2" });
let QUEUE_PAGE: unknown = queuePage();

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
    { match: /\/mangadex\/search/, body: { results: SEARCH_RESULTS } },
    { match: /\/untracked\/automap$/, body: () => AUTOMAP_REPORT },
    { match: /\/extensions$/, body: { extensions: [{ name: "opstest" }, { name: "mangaup_global" }] } },
    { match: /\/untracked\/[^/]+\/map$/, body: { ok: true, mdMangaId: MATCH_ID } },
    { match: /\/untracked\/[^/?]+$/, body: { untracked: ROW, mangadex: null } },
    { match: /\/untracked\?/, body: () => QUEUE_PAGE },
  ];
}

let requested: string[] = [];

function installFetch(): void {
  const routes = apiRoutes();
  win.fetch = vi.fn(async (url: string) => {
    const path = String(url);
    requested.push(path);
    const route = routes.find((r) => r.match.test(path));
    const raw = route ? route.body : {};
    const body = typeof raw === "function" ? (raw as () => unknown)() : raw;
    return {
      ok: Boolean(route),
      status: route ? 200 : 404,
      statusText: route ? "OK" : "Not Found",
      text: async () => JSON.stringify(body),
    };
  });
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

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

async function goto(hash: string): Promise<void> {
  win.location.hash = hash;
  await settle();
}

const text = (): string => doc.getElementById("view").textContent ?? "";

const click = (label: string): void => {
  const button = [...doc.querySelectorAll("button")].find(
    (b: { textContent: string }) => b.textContent === label,
  );
  expect(button, `no button labelled ${label}`).toBeTruthy();
  button.click();
};

const calls = (fragment: string) =>
  win.fetch.mock.calls.filter(([url]: [string]) => String(url).includes(fragment));

describe("mapping an untracked series onto an existing MangaDex title", () => {
  beforeEach(async () => {
    requested = [];
    AUTOMAP_REPORT = previewReport();
    QUEUE_PAGE = queuePage();
    const html = readFileSync(INDEX_HTML, "utf8");
    const body = html.split("<body>")[1]?.split("</body>")[0];
    if (!body) throw new Error("index.html has no <body>: the dashboard shell cannot be mounted");
    doc.body.innerHTML = body;
    win.location.hash = "";
    stubDialogs();
    installFetch();
    new Function(readFileSync(APP_JS, "utf8")).call(win);
    await settle(10);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllTimers();
  });

  it("seeds the search with the scraped name, so the common case is one click", async () => {
    await goto(`#/untracked/${ROW_ID}`);
    expect(text()).toContain("Find it on MangaDex");

    const input = doc.getElementById("untracked-md-q");
    expect(input, "the search box is not rendered").toBeTruthy();
    // The name the scraper reported is the query an operator would type first.
    expect(input.value).toBe("Mangled Nmae");
    // Nothing is searched until asked: this view is also read by people just
    // looking at the row.
    expect(calls("/mangadex/search")).toHaveLength(0);
  });

  it("searches MangaDex and marks the candidate that matches the scraped name", async () => {
    await goto(`#/untracked/${ROW_ID}`);
    click("Search");
    await settle(15);

    const [url] = calls("/mangadex/search")[0];
    expect(String(url)).toContain(`q=${encodeURIComponent("Mangled Nmae")}`);
    // The reported name travels separately, so widening the query does not
    // silently change what "likely" is measured against.
    expect(String(url)).toContain(`reportedName=${encodeURIComponent("Mangled Nmae")}`);

    expect(text()).toContain("Mangled Nmae");
    expect(text()).toContain("Something Else");
    expect(text()).toContain("likely match");
    // Alt titles help tell two similarly-named series apart.
    expect(text()).toContain("A Mangled Name");
  });

  it("maps the chosen title after a confirmation, and creates nothing", async () => {
    await goto(`#/untracked/${ROW_ID}`);
    click("Search");
    await settle(15);

    click("Map");
    await settle();
    // The confirm dialog stands between the click and the write.
    expect(calls("/map")).toHaveLength(0);
    click("Map to this title");
    await settle(15);

    const writes = calls("/map");
    expect(writes).toHaveLength(1);
    const [url, init] = writes[0];
    expect(String(url)).toContain(`/untracked/${ROW_ID}/map`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body ?? "{}")).toEqual({ mdMangaId: MATCH_ID });
    // Mapping is the alternative to creating a title, never both.
    expect(calls("/approve")).toHaveLength(0);
  });

  it("writes nothing if the confirmation is dismissed", async () => {
    await goto(`#/untracked/${ROW_ID}`);
    click("Search");
    await settle(15);

    click("Map");
    await settle();
    click("Cancel");
    await settle(10);

    expect(calls("/map")).toHaveLength(0);
  });

  it("previews the auto-map without writing, and says what it would do", async () => {
    await goto("#/untracked");
    expect(text()).toContain("Auto-map onto titles MangaDex already has");

    click("Find matches");
    await settle(15);

    const [, init] = calls("/untracked/automap")[0];
    expect(init.method).toBe("POST");
    // Preview must be a dry run; this endpoint writes the series map. And the
    // link is the default evidence: it is the stronger of the two, so the
    // weaker one is never what an unchanged card runs.
    expect(JSON.parse(init.body ?? "{}")).toMatchObject({ dryRun: true, limit: 50, strategy: "link" });

    expect(text()).toContain("Would map 1 of the 25 row(s) checked");
    // A pass that maps nothing is the normal case here, so the card has to say
    // how much queue is left or a zero reads as a broken button.
    expect(text()).toContain("1987 row(s) still to check");
    // Ambiguity is the one outcome that needs a person, so it is never folded
    // away into "unmatched".
    expect(text()).toContain("1 ambiguous");
    expect(text()).toContain("Nothing was written");
  });

  it("runs the title pass when asked, and says the evidence changed", async () => {
    AUTOMAP_REPORT = { ...previewReport(), strategy: "title", ambiguous: 2, unmatched: 20 };
    await goto("#/untracked");
    await settle(15);
    doc.getElementById("automap-strategy").value = "title";

    click("Find matches");
    await settle(15);

    expect(JSON.parse(calls("/untracked/automap")[0][1].body ?? "{}")).toMatchObject({
      dryRun: true,
      strategy: "title",
    });
    // The two passes fail for different reasons, and an operator reading a zero
    // needs to know which one they ran: "nobody links here" and "MangaDex
    // spells it another way" have different next moves.
    expect(text()).toContain("two titles answer to one name");
    expect(text()).toContain("with no title of that exact name");
  });

  it("offers the live extensions as a picker rather than a text box", async () => {
    await goto("#/untracked");
    await settle(15);
    const ext = doc.getElementById("automap-extension");
    expect(ext, "the extension picker is not rendered").toBeTruthy();
    expect(ext.tagName).toBe("SELECT");

    // A typo in a free-text box reads exactly like "nothing to map here",
    // which is the same answer a correct name usually gives.
    const options = [...ext.querySelectorAll("option")].map((o: { value: string }) => o.value);
    expect(options).toEqual(["", "mangaup_global", "opstest"]);
  });

  it("scopes the run to one extension when asked", async () => {
    await goto("#/untracked");
    await settle(15);
    const ext = doc.getElementById("automap-extension");
    const limit = doc.getElementById("automap-limit");
    ext.value = "mangaup_global";
    limit.value = "100";

    click("Find matches");
    await settle(15);

    const [, init] = calls("/untracked/automap")[0];
    expect(JSON.parse(init.body ?? "{}")).toMatchObject({
      dryRun: true,
      limit: 100,
      extension: "mangaup_global",
    });
  });

  it("commits only after the confirmation, and then not as a dry run", async () => {
    AUTOMAP_REPORT = { ...previewReport(), dryRun: false, ambiguous: 0, unmatched: 24 };
    await goto("#/untracked");

    click("Map them");
    await settle();
    // The confirm dialog stands between the click and any write.
    expect(calls("/untracked/automap")).toHaveLength(0);

    click("Add the mappings");
    await settle(15);

    const writes = calls("/untracked/automap");
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0][1].body ?? "{}")).toMatchObject({ dryRun: false });
    expect(text()).toContain("Mapped 1 of the 25 row(s) checked");
    // After a commit the card has to say the mapping happened; the rows
    // themselves vanish from the NEW queue, which on its own looks like
    // nothing was done.
    expect(text()).toContain("auto:official-link");
  });

  it("writes nothing if the auto-map confirmation is dismissed", async () => {
    await goto("#/untracked");
    click("Map them");
    await settle();
    click("Cancel");
    await settle(10);

    expect(calls("/untracked/automap")).toHaveLength(0);
  });

  it("says how much of the queue it is showing, and offers the next page", async () => {
    await goto("#/untracked");
    await settle(15);

    // The original complaint: a fixed window onto a queue thousands deep looks
    // exactly like the whole list unless the count says otherwise. "Loaded"
    // rather than "shown" since the table under it pages the batch at twenty.
    expect(text()).toContain("1 loaded of 2243 matching");

    const before = calls("/untracked?").length;
    click("Next →");
    await settle(15);

    const last = calls("/untracked?").at(-1);
    expect(calls("/untracked?").length).toBeGreaterThan(before);
    expect(String(last[0])).toContain("cursor=cursor-page-2");
    expect(text()).toContain("page 2");
  });

  it("filters by extension from a picker, and drops the page position when it changes", async () => {
    await goto("#/untracked");
    await settle(15);
    const ext = doc.getElementById("untracked-extension");
    expect(ext, "the extension filter is not rendered").toBeTruthy();
    expect(ext.tagName).toBe("SELECT");
    expect([...ext.querySelectorAll("option")].map((o: { value: string }) => o.value)).toEqual([
      "",
      "mangaup_global",
      "opstest",
    ]);

    // Walk to page two first, so the reset is observable.
    click("Next →");
    await settle(15);

    ext.value = "mangaup_global";
    ext.dispatchEvent(new win.Event("change", { bubbles: true }));
    await settle(15);

    const last = String(calls("/untracked?").at(-1)[0]);
    expect(last).toContain("extension=mangaup_global");
    // A cursor names a row in one ordering of one filter; carrying it across a
    // filter change pages from a row that may not be in the new list at all.
    expect(last).not.toContain("cursor=");
  });

  it("searches the queue itself, so one series can be found among thousands", async () => {
    await goto("#/untracked");
    const search = doc.getElementById("untracked-q");
    expect(search, "the queue search box is not rendered").toBeTruthy();

    search.value = "findable";
    search.dispatchEvent(new win.Event("change", { bubbles: true }));
    await settle(15);

    const listCalls: string[] = calls("/untracked?").map(([url]: [string]) => String(url));
    expect(listCalls.some((url: string) => url.includes("q=findable"))).toBe(true);
    // The state filter is not dropped when a search is added; they compose.
    expect(
      listCalls.some((url: string) => url.includes("state=NEW") && url.includes("q=findable")),
    ).toBe(true);
  });
});
