// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Errors view, actually rendered; specifically the controls that clear a
 * failure once it has been dealt with.
 *
 * Same approach as `dashboardChapters.test.ts`: `dashboard/app.js` is vanilla
 * JavaScript that nothing type-checks, so a mistyped helper is a blank card and a
 * green suite. This drives the real file under jsdom against a stubbed API,
 * clicks the buttons an operator clicks, and asserts what went over the wire.
 *
 * The wire assertions are the point. Clearing is the one thing in this view that
 * changes what the next operator sees, and it must send a source with the id
 * (three tables share an id space) and must not be reachable without
 * `runs:write`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any --
   The DOM lib is deliberately kept out of this program, so the jsdom globals are
   loosely typed in this file only. */
const doc: any = (globalThis as any).document;
const win: any = globalThis;
/* eslint-enable @typescript-eslint/no-explicit-any */

const DASHBOARD = resolve(process.cwd(), "src/core/api/dashboard");
const APP_JS = join(DASHBOARD, "app.js");
const INDEX_HTML = join(DASHBOARD, "index.html");

const JOB_ID = "3f9a1c2b-0000-4000-8000-000000000001";
const TASK_ID = "7b1c2d3e-0000-4000-8000-000000000002";

/** Every fetch the page made, so a test can assert method and body. */
let calls: { url: string; method: string; body: unknown }[] = [];

/** What `/errors` answers next; tests swap it to simulate a reload. */
let feed: unknown;

/** Scopes the stubbed principal holds: the gate on the Clear buttons. */
let scopes: string[];

function routes(): { match: RegExp; body: unknown }[] {
  return [
    { match: /\/session$/, body: { actor: "ardax", role: "OWNER", userId: "u1", email: "a@b.c" } },
    {
      match: /\/whoami$/,
      body: {
        kind: "session",
        name: "ardax",
        role: "OWNER",
        get scopes() {
          return scopes;
        },
        csrfHeader: "x-requested-with",
        csrfValue: "publoader-dash",
      },
    },
    {
      match: /\/stats$/,
      body: {
        paused: false,
        workers: {},
        jobs: {},
        uploadTasks: [],
        quarantined: 3,
        errorsOutstanding: { total: 2, jobs: 1, uploadTasks: 1, submissions: 0 },
      },
    },
    { match: /\/runs\?limit=1/, body: { runs: [] } },
    { match: /\/errors\/clear$/, body: { ok: true, cleared: 1, entries: [{ source: "job", id: JOB_ID }], skipped: [] } },
    { match: /\/errors\/restore$/, body: { ok: true, restored: 1 } },
    {
      match: /\/errors\?/,
      get body() {
        return feed;
      },
    },
  ];
}

function installFetch(): void {
  const table = routes();
  win.fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const path = String(url);
    calls.push({
      url: path,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(init.body) : undefined,
    });
    const route = table.find((r) => r.match.test(path));
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
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

const view = (): string => doc.getElementById("view").textContent ?? "";

/** Buttons in the view whose label is exactly `label`. */
function buttons(label: string): { textContent: string; disabled: boolean; click: () => void }[] {
  return [...doc.getElementById("view").querySelectorAll("button")].filter(
    (b: { textContent: string }) => (b.textContent ?? "").trim() === label,
  );
}

async function goto(hash: string): Promise<void> {
  win.location.hash = hash;
  await settle();
}

const OUTSTANDING = {
  clearedHidden: 1,
  errors: [
    {
      at: "2026-08-01T00:00:00Z",
      kind: "job:DEAD_LETTER",
      source: "job",
      subject: "mangaplus · segment 1/1",
      message: "[PERMANENT] extension threw",
      id: JOB_ID,
    },
    {
      at: "2026-08-01T00:00:00Z",
      kind: "upload-task:FAILED",
      source: "upload-task",
      subject: "UPLOAD · src-1|142|en",
      message: "md 503",
      id: TASK_ID,
    },
  ],
};

describe("dashboard errors view", () => {
  beforeEach(async () => {
    calls = [];
    scopes = ["*"];
    feed = OUTSTANDING;
    const html = readFileSync(INDEX_HTML, "utf8");
    const body = html.split("<body>")[1]?.split("</body>")[0];
    if (!body) throw new Error("index.html has no <body>: the dashboard shell cannot be mounted");
    doc.body.innerHTML = body;
    win.location.hash = "";
    installFetch();

    // jsdom has <dialog> without its modal methods, and "Clear all" opens one.
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

    new Function(readFileSync(APP_JS, "utf8")).call(win);
    await settle(10);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllTimers();
  });

  it("lists outstanding failures, says how many are hidden, and offers to clear each", async () => {
    await goto("#/errors");
    expect(view()).toContain("mangaplus · segment 1/1");
    expect(view()).toContain("md 503");
    // The hidden count is what keeps an empty list from reading as "nothing ever
    // failed".
    expect(view()).toContain("1 cleared entry is hidden");
    expect(buttons("Clear")).toHaveLength(2);
    // Cleared entries are hidden unless asked for.
    expect(calls.some((c) => /\/errors\?limit=100&cleared=without/.test(c.url))).toBe(true);
  });

  it("clears one failure with its source, not just its id", async () => {
    await goto("#/errors");
    buttons("Clear")[0]!.click();
    await settle();

    const clear = calls.find((c) => c.url.endsWith("/errors/clear"));
    expect(clear).toBeDefined();
    expect(clear!.method).toBe("POST");
    // Source travels with the id: three tables share the id space, and clearing
    // the wrong one would hide a failure nobody has looked at.
    expect(clear!.body).toMatchObject({ refs: [{ source: "job", id: JOB_ID }] });
    // And the feed is re-read, so the row leaves the page without a manual reload.
    expect(calls.filter((c) => /\/errors\?/.test(c.url)).length).toBeGreaterThan(1);
  });

  it("sends the operator's note along with the clear", async () => {
    await goto("#/errors");
    const note = doc.getElementById("errors-note");
    note.value = "upstream 503s, fixed in 1.4.2";
    buttons("Clear")[0]!.click();
    await settle();

    expect(calls.find((c) => c.url.endsWith("/errors/clear"))!.body).toMatchObject({
      note: "upstream 503s, fixed in 1.4.2",
    });
  });

  it("reviews cleared entries and restores one", async () => {
    feed = {
      clearedHidden: 0,
      errors: [
        {
          ...OUTSTANDING.errors[0],
          cleared: { at: "2026-08-02T00:00:00Z", by: "user:ardax", note: "upstream fixed" },
        },
      ],
    };
    await goto("#/errors");
    doc.getElementById("errors-cleared").value = "only";
    doc.getElementById("errors-cleared").dispatchEvent(new win.Event("change"));
    await settle();

    expect(calls.some((c) => /cleared=only/.test(c.url))).toBe(true);
    // Who dealt with it and why, not just that it is gone.
    expect(view()).toContain("user:ardax");
    expect(view()).toContain("upstream fixed");

    const restore = buttons("Restore");
    expect(restore).toHaveLength(1);
    restore[0]!.click();
    await settle();
    expect(calls.find((c) => c.url.endsWith("/errors/restore"))!.body).toMatchObject({
      refs: [{ source: "job", id: JOB_ID }],
    });
  });

  it("badges the sidebar with outstanding failures rather than every quarantine", async () => {
    // The stub says quarantined: 3 but errorsOutstanding.total: 2. The badge must
    // follow the number that respects clearing, or it nags about handled work,
    // so this asserts the exact badge text, not that "2" appears somewhere.
    await settle();
    const badges = [...doc.getElementById("nav").querySelectorAll(".nav-count")];
    expect(badges).toHaveLength(1);
    expect(badges[0]!.textContent.trim()).toBe("2");
  });

  it("disables clearing for a principal without runs:write", async () => {
    scopes = ["runs:read"];
    // Re-boot the page so the sign-in path picks up the narrower scope set.
    doc.body.innerHTML = readFileSync(INDEX_HTML, "utf8").split("<body>")[1]!.split("</body>")[0]!;
    win.location.hash = "#/errors";
    new Function(readFileSync(APP_JS, "utf8")).call(win);
    await settle(10);

    const clear = buttons("Clear");
    expect(clear.length).toBeGreaterThan(0);
    for (const button of clear) expect(button.disabled).toBe(true);
    expect(calls.some((c) => c.url.endsWith("/errors/clear"))).toBe(false);
  });
});
