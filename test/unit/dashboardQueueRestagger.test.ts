// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Space out" acts on the rows an operator picked, not always on all of them.
 *
 * The bug this covers was reported from the console, not from the API: with one
 * task ticked, pressing Space out re-spaced the entire 32,000-row queue. The
 * button was real and did what it was written to do — it just had no way to
 * mean "these". So these tests drive the real app.js under jsdom and assert on
 * the request body that leaves it, because the request body is the only place
 * the difference between "these" and "all of them" is visible.
 *
 * Mounted the same way as dashboardTables.test.ts; see the note there on why
 * app.js is evaluated as a classic script against a stubbed fetch.
 */

/* eslint-disable @typescript-eslint/no-explicit-any --
   The DOM lib is deliberately kept out of this program (see dashboardModules
   .test.ts), so the jsdom globals and the nodes read out of them are loosely
   typed in this file only. */
const doc: any = (globalThis as any).document;
const win: any = globalThis;

const DASHBOARD = resolve(process.cwd(), "src/core/api/dashboard");
const APP_JS = join(DASHBOARD, "app.js");
const INDEX_HTML = join(DASHBOARD, "index.html");

/** Three pending UPLOAD rows: enough to tell "one of them" from "all of them". */
const TASKS = Array.from({ length: 3 }, (_, i) => ({
  id: `task-${i}`,
  kind: "UPLOAD",
  state: "PENDING",
  dedupeKey: `mangaup_global:chapter:${i}`,
  attempt: 0,
  maxAttempts: 5,
  notBefore: new Date(Date.UTC(2026, 0, 2, 0, i)).toISOString(),
  lastError: null,
  identity: { chapterNumber: String(i + 1), chapterLanguage: "en" },
}));

/** Every request the app made, so a test can assert on what it sent. */
let sent: { url: string; method: string; body: any }[] = [];

function installFetch(): void {
  sent = [];
  win.fetch = vi.fn(async (url: string, init?: any) => {
    const path = String(url);
    sent.push({
      url: path,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(init.body) : null,
    });

    const route = (body: unknown) => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify(body),
    });

    if (/\/session$/.test(path)) {
      return route({ actor: "ardax", role: "OWNER", userId: "u1", email: "a@b.c" });
    }
    if (/\/whoami$/.test(path)) {
      return route({
        kind: "session",
        name: "ardax",
        role: "OWNER",
        scopes: ["*"],
        csrfHeader: "x-requested-with",
        csrfValue: "publoader-dash",
      });
    }
    if (/\/queues\/restagger$/.test(path)) {
      return route({ ok: true, moved: 1, gapSeconds: 60, scope: "ids", spansSeconds: 0 });
    }
    if (/\/queues\/tasks/.test(path)) {
      return route({
        tasks: TASKS,
        total: TASKS.length,
        limit: 100,
        nextCursor: null,
        summary: [],
      });
    }
    if (/\/queues/.test(path)) {
      // The depth summary, which takes no query: `total` counts every row on
      // record, DONE included. A dialog that sized the queue with this reported
      // 45,000 for a queue with 32,000 rows left to upload.
      return route({ summary: [], total: 45_991 });
    }
    if (/\/stats$/.test(path)) {
      return route({ paused: false, workers: {}, jobs: {}, uploadTasks: [], quarantined: 0 });
    }
    if (/\/runs/.test(path)) return route({ runs: [] });
    if (/\/extensions$/.test(path)) return route({ extensions: [{ name: "mangaup_global" }] });
    return route({});
  });
}

async function settle(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

/**
 * jsdom implements <dialog> as an element but not its modal methods, so the
 * real `showModal()` every dialog in app.js calls throws asynchronously out of
 * a click handler, which vitest reports as an unhandled error even when the
 * assertions pass. Same shim as dashboardMapSync.test.ts; these tests read the
 * dialog's content and click its buttons, not its modality.
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
  // Evaluated rather than imported: app.js is deliberately a classic script, so
  // this is how a browser runs it. The source is this repo's own file read from
  // disk; nothing is interpolated into it.
  new Function(readFileSync(APP_JS, "utf8")).call(win);
}

/**
 * The last node matching `text`, because every test evaluates app.js again on
 * the one jsdom window and earlier instances leave their nodes behind.
 */
const buttonSaying = (text: string): any =>
  [...doc.querySelectorAll("button")].filter((b: any) => b.textContent.trim() === text).at(-1);

/**
 * The two "Space out…" buttons, told apart by where they live rather than by
 * whether they are enabled — the filter card's copy is never disabled, so
 * "the enabled one" silently means the wrong button once a row is ticked.
 */
const spaceOutIn = (selector: string | null): any => {
  const scope = selector
    ? [...doc.querySelectorAll(selector)].at(-1)
    : [...doc.querySelectorAll(".card")].filter(
        (c: any) => !c.querySelector(".bulk-bar") && c.textContent.includes("Space out"),
      ).at(-1);
  if (!scope) throw new Error(`no ${selector ?? "filter card"} on screen`);
  return [...scope.querySelectorAll("button")]
    .filter((b: any) => b.textContent.trim() === "Space out…")
    .at(-1);
};

/** The selection bar's copy: the one that can mean "these rows". */
const bulkSpaceOut = (): any => spaceOutIn(".bulk-bar");

/** The filter card's copy: the one that means the whole kind. */
const toolbarSpaceOut = (): any => spaceOutIn(null);

const restaggerCalls = (): any[] => sent.filter((r) => /\/queues\/restagger$/.test(r.url));

async function openQueue(): Promise<void> {
  win.location.hash = "#/queues/tasks";
  await settle(12);
}

/**
 * Tick one row, addressed the way a screen reader would: the checkbox carries
 * `aria-label="Select <dedupeKey>"`, which is the only stable handle on a row
 * from outside — the id itself is never drawn.
 */
async function tick(dedupeKey: string): Promise<void> {
  const boxes = [...doc.querySelectorAll(`input[aria-label="Select ${dedupeKey}"]`)];
  const box: any = boxes.at(-1);
  if (!box) throw new Error(`no row on screen for ${dedupeKey}`);
  box.click();
  await settle();
}

describe("Space out respects the selection", () => {
  beforeEach(async () => {
    mount();
    await settle(12);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllTimers();
  });

  it("sends only the ticked row, not the whole queue", async () => {
    await openQueue();
    await tick("mangaup_global:chapter:1");

    const bulk = bulkSpaceOut();
    expect(bulk).toBeTruthy();
    // Enabled only once something is ticked, which is the whole contract.
    expect(bulk.disabled).toBe(false);
    bulk.click();
    await settle();

    buttonSaying("Space them out").click();
    await settle();

    const calls = restaggerCalls();
    expect(calls.length).toBe(1);
    // The whole point: ids, and only the one that was ticked.
    expect(calls[0]!.body.ids).toEqual(["task-1"]);
    expect(calls[0]!.body.gapSeconds).toBe(60);
  });

  it("does not rewrite the standing pace when only a selection was spaced", async () => {
    await openQueue();
    await tick("mangaup_global:chapter:0");
    bulkSpaceOut().click();
    await settle();
    buttonSaying("Space them out").click();
    await settle();

    // Spacing one row must not change the rate every future chapter queues at.
    // That offer belongs to the whole-queue scope, and nowhere else.
    expect(sent.filter((r) => /\/upload-schedule$/.test(r.url) && r.method === "POST")).toEqual([]);
  });

  it("leaves the selection button disabled until something is ticked", async () => {
    await openQueue();
    // The complaint was that Space out ignored the selection. The bulk bar's
    // copy being dead at zero is what stops it meaning something else instead.
    expect(bulkSpaceOut().disabled).toBe(true);
  });

  it("still paces the whole kind when nothing is ticked", async () => {
    await openQueue();

    // The filter card's copy, which is never gated on a selection.
    const toolbar = toolbarSpaceOut();
    expect(toolbar).toBeTruthy();
    toolbar.click();
    await settle();
    buttonSaying("Space them out").click();
    await settle();

    const calls = restaggerCalls();
    expect(calls.length).toBe(1);
    expect(calls[0]!.body.ids).toBeUndefined();
    expect(calls[0]!.body.kind).toBe("UPLOAD");
  });

  it("sizes the queue from the list, not from the depth summary", async () => {
    await openQueue();
    const before = sent.length;
    toolbarSpaceOut().click();
    await settle();

    // `/queues` is the depth summary and ignores every filter, so its `total`
    // counts DONE rows too — the 45,991 the stub returns above. The estimate
    // has to come from `/queues/tasks`, which applies `state=PENDING`.
    const counted = sent.slice(before).filter((r) => r.method === "GET" && /\/queues/.test(r.url));
    expect(counted.length).toBeGreaterThan(0);
    for (const call of counted) {
      expect(call.url).toContain("/queues/tasks");
      expect(call.url).toContain("state=PENDING");
    }
    expect(doc.getElementById("modal").textContent).not.toContain("45991");
  });
});
