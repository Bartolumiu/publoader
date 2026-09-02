// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The series map read as one list, across every extension.
 *
 * WHAT THIS IS FOR. The map is keyed by (extension, catalogue, series), and the
 * console could only ever show it that way: six extensions, a count each, and a
 * link into one of them. That answers the platform's question and not the
 * operator's, because the operator's questions are not about an extension —
 *
 *   "which publishers feed this MangaDex title?" Two extensions mapping to one
 *   title is legitimate, and is also what a mis-mapping looks like; telling
 *   those apart needs both rows on one screen, which nothing could produce.
 *
 * Driven like the sibling dashboard tests: the real app.js under jsdom against
 * a stubbed API.
 */

/* eslint-disable @typescript-eslint/no-explicit-any --
   The DOM lib is deliberately out of this program; see dashboardModules.test.ts. */
const doc: any = (globalThis as any).document;
const win: any = globalThis;

const DASHBOARD = resolve(process.cwd(), "src/core/api/dashboard");
const APP_JS = join(DASHBOARD, "app.js");
const INDEX_HTML = join(DASHBOARD, "index.html");

const SHARED_TITLE = "aaaaaaaa-0000-4000-8000-000000000001";
const LONE_TITLE = "bbbbbbbb-0000-4000-8000-000000000002";

/** One title two publishers feed, and one only one does. */
const LISTING = () => ({
  tracked: [
    {
      id: "t1",
      extension: "comikey",
      namespace: "",
      mangaId: "kengan-omega",
      mdMangaId: SHARED_TITLE,
      source: "operator:ardax",
      sources: 2,
      createdAt: "2026-08-01T00:00:00.000Z",
      recheckAfter: null,
    },
    {
      id: "t2",
      extension: "omoi",
      namespace: "",
      mangaId: "0b9110ef",
      mdMangaId: SHARED_TITLE,
      source: "auto:official-link",
      sources: 2,
      createdAt: "2026-08-02T00:00:00.000Z",
      recheckAfter: null,
    },
    {
      id: "t3",
      extension: "mangaplus",
      namespace: "",
      mangaId: "100818",
      mdMangaId: LONE_TITLE,
      source: "operator:ardax",
      sources: 1,
      createdAt: "2026-08-03T00:00:00.000Z",
      recheckAfter: null,
    },
  ],
  total: 3,
  limit: 50,
  nextCursor: null,
  orderedBy: null,
  dir: "asc",
  sortable: ["extension", "catalogue", "series", "mangadex", "source", "added"],
});

const FACETS = {
  extensions: [
    { extension: "comikey", count: 686 },
    { extension: "omoi", count: 1075 },
    { extension: "mangaplus", count: 1047 },
  ],
  namespaces: [{ namespace: "", count: 2808 }],
};

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
    { match: /\/source\/resolve/, body: { match: null, reason: "nothing" } },
    { match: /\/tracked\/extensions$/, body: FACETS },
    { match: /\/tracked\?/, body: () => LISTING() },
    { match: /\/extensions\/[^/]+\/tracked\/[^/]+$/, body: { ok: true } },
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

async function settle(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

const text = (): string => doc.getElementById("view").textContent ?? "";
const buttonLabelled = (label: string, root: any = doc): any =>
  [...root.querySelectorAll("button")].find((b: any) => b.textContent === label);

const listings = () => calls.filter((c) => /\/tracked\?/.test(c.path));
const lastListing = () => String(listings()[listings().length - 1]!.path);

function rowFor(mangaId: string): any {
  const cell = [...doc.querySelectorAll("td")].find((td: any) => td.textContent?.includes(mangaId));
  expect(cell, `no row for ${mangaId}`).toBeTruthy();
  return cell.parentElement;
}

describe("the series map across every extension", () => {
  beforeEach(async () => {
    calls = [];
    const html = readFileSync(INDEX_HTML, "utf8");
    const body = html.split("<body>")[1]?.split("</body>")[0];
    if (!body) throw new Error("index.html has no <body>: the dashboard shell cannot be mounted");
    doc.body.innerHTML = body;
    win.location.hash = "";
    stubDialogs();
    installFetch();
    new Function(readFileSync(APP_JS, "utf8")).call(win);
    await settle();
    win.location.hash = "#/tracked";
    await settle();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllTimers();
  });

  it("lists mappings from every extension on one page", () => {
    expect(text()).toContain("comikey");
    expect(text()).toContain("omoi");
    expect(text()).toContain("mangaplus");
    expect(text()).toContain("kengan-omega");
  });

  it("counts the publishers feeding each title", () => {
    expect(buttonLabelled("2 sources")).toBeTruthy();
    // One source is not a finding, so it is not a control.
    expect(rowFor("100818").textContent).toContain("1");
  });

  it("shows every mapping for one title when the count is pressed", async () => {
    buttonLabelled("2 sources").click();
    await settle();
    // The whole point of the view: from "this title has two publishers" to the
    // two rows, without knowing either extension's name first.
    expect(lastListing()).toContain(`mdMangaId=${SHARED_TITLE}`);
  });

  it("takes a pasted title link, not just a bare id", async () => {
    const input = doc.getElementById("tracked-all-md");
    input.value = `https://mangadex.org/title/${LONE_TITLE}/some-slug`;
    input.dispatchEvent(new win.Event("change"));
    await settle();
    expect(lastListing()).toContain(`mdMangaId=${LONE_TITLE}`);
  });

  it("refuses a link that is not a MangaDex title, without asking the server", async () => {
    const before = listings().length;
    const input = doc.getElementById("tracked-all-md");
    input.value = "https://comikey.com/comics/kengan-omega";
    input.dispatchEvent(new win.Event("change"));
    await settle();
    expect(listings()).toHaveLength(before);
  });

  it("can list only the titles more than one publisher feeds", async () => {
    const select = doc.getElementById("tracked-all-shared");
    select.value = "only";
    select.dispatchEvent(new win.Event("change"));
    await settle();
    expect(lastListing()).toContain("shared=only");
  });

  it("marks a mapping nobody reviewed", () => {
    // `auto:official-link` is the one source string that means "matched
    // automatically, by nothing that can be asked why".
    const auto = rowFor("0b9110ef").querySelector(".chip.warn");
    expect(auto).toBeTruthy();
    expect(auto.textContent).toBe("auto:official-link");
  });

  it("orders the whole map on the server, not the page in hand", async () => {
    const header = [...doc.querySelectorAll("th button, th a")].find((b: any) =>
      b.textContent?.includes("Extension"),
    );
    expect(header, "the Extension column is not sortable").toBeTruthy();
    header.click();
    await settle();
    expect(lastListing()).toContain("orderBy=extension");
  });

  it("says what removing one of two mappings does to the other", async () => {
    buttonLabelled("Remove", rowFor("kengan-omega")).click();
    await settle();
    const modal = doc.getElementById("modal");
    expect(modal.textContent).toContain("1 other mapping(s)");
    // It keeps being fed: removing one publisher is not unpublishing the title.
    expect(modal.textContent).toContain("left alone");
  });

  it("removes through the extension the mapping belongs to", async () => {
    buttonLabelled("Remove", rowFor("100818")).click();
    await settle();
    buttonLabelled("Stop tracking it", doc.getElementById("modal")).click();
    await settle();
    const [deleted] = calls.filter((c) => c.method === "DELETE");
    expect(String(deleted!.path)).toContain("/extensions/mangaplus/tracked/100818");
  });
});
