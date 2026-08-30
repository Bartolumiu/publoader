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
    { match: /\/untracked\/[^/]+\/map$/, body: { ok: true, mdMangaId: MATCH_ID } },
    { match: /\/untracked\/[^/?]+$/, body: { untracked: ROW, mangadex: null } },
    { match: /\/untracked\?/, body: { untracked: [ROW] } },
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
