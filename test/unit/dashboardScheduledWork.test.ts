// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The console's view of what this platform does to itself on a clock.
 *
 * There is no cron here and no job table: every periodic thing is a loop that
 * sleeps at the bottom, or a `setInterval`. So the question "what runs on its
 * own, how often, and did it" had no answer short of reading source — and the
 * jobs that matter most are the least visible, because a pass that mapped
 * nothing and a pass that never ran look identical from outside.
 *
 * What this file mostly guards is the honesty: most of these jobs record
 * nothing when they run, and a blank "last run" cell reads as "it has never
 * run", which is a different and much more alarming claim.
 */

/* eslint-disable @typescript-eslint/no-explicit-any --
   The DOM lib is deliberately out of this program; see dashboardModules.test.ts. */
const doc: any = (globalThis as any).document;
const win: any = globalThis;

const DASHBOARD = resolve(process.cwd(), "src/core/api/dashboard");
const APP_JS = join(DASHBOARD, "app.js");
const INDEX_HTML = join(DASHBOARD, "index.html");

let TASKS: any = null;

const report = (over: Record<string, unknown> = {}) => ({
  paused: false,
  tasks: [
    {
      id: "scheduler-tick",
      name: "Scheduler tick",
      what: "Creates due extension runs and sweeps expired leases.",
      service: "core-scheduler",
      everySeconds: 30,
      configuredBy: "env SCHEDULER_INTERVAL_SECONDS (at boot)",
      enabled: true,
      lastRun: "2026-09-02T21:00:00.000Z",
      lastRunKnown: true,
    },
    {
      id: "auto-map",
      name: "Auto-map untracked series",
      what: "Maps an untracked series onto a MangaDex title that names its page.",
      service: "core-uploader",
      everySeconds: null,
      cadence: "Once per upload-queue pass: about every 5s while the queue is idle.",
      configuredBy: "hardcoded (AUTO_MAP_BATCH, RECHECK_AFTER_MS)",
      enabled: true,
      batch: 20,
      recheckDays: 14,
      lastRun: null,
      lastRunKnown: false,
      progress: { newestRowChecked: "2026-09-02T20:00:00.000Z", rowsDue: 1987, newRows: 2243 },
      note: "Nothing records the pass itself.",
    },
    {
      id: "github-sync",
      name: "Extension auto-sync from GitHub",
      what: "Publishes anything new in the extension repositories.",
      service: "core-scheduler",
      everySeconds: 900,
      configuredBy: "hardcoded interval; on/off in settings",
      enabled: false,
      lastRun: null,
      lastRunKnown: true,
    },
  ],
  ...over,
});

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
    { match: /\/system\/tasks$/, body: () => TASKS },
  ];
}

function installFetch(): void {
  const routes = apiRoutes();
  win.fetch = vi.fn(async (url: string) => {
    const path = String(url);
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

async function settle(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

const text = (): string => doc.getElementById("view").textContent ?? "";

describe("the scheduled-work panel", () => {
  beforeEach(async () => {
    TASKS = report();
    const html = readFileSync(INDEX_HTML, "utf8");
    const body = html.split("<body>")[1]?.split("</body>")[0];
    if (!body) throw new Error("index.html has no <body>: the dashboard shell cannot be mounted");
    doc.body.innerHTML = body;
    win.location.hash = "";
    installFetch();
    new Function(readFileSync(APP_JS, "utf8")).call(win);
    await settle();
    win.location.hash = "#/system/scheduled";
    await settle();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllTimers();
  });

  it("lists the periodic work with its cadence", () => {
    expect(text()).toContain("Scheduler tick");
    expect(text()).toContain("every 30s");
    expect(text()).toContain("Extension auto-sync from GitHub");
    expect(text()).toContain("every 15m");
  });

  it("says where each interval is set, so 'can I change it' is not a guess", () => {
    expect(text()).toContain("SCHEDULER_INTERVAL_SECONDS");
    expect(text()).toContain("hardcoded");
  });

  it("distinguishes 'records nothing' from 'has never run'", () => {
    // The whole point. The auto-map keeps no pass-level record; the GitHub sync
    // does and simply has not run yet, and those must not read the same.
    expect(text()).toContain("not recorded");
    expect(text()).toContain("no record yet");
  });

  it("reports the progress a per-row job keeps instead of a pass timestamp", () => {
    expect(text()).toContain("1,987 row(s) still to check");
    expect(text()).toContain("20 row(s) a pass");
  });

  it("does not claim a fixed interval for a pass that rides another loop", () => {
    expect(text()).toContain("Once per upload-queue pass");
  });

  it("marks a job whose switch is off", () => {
    expect(text()).toContain("off");
  });

  it("says plainly when a pause has stopped the lot", async () => {
    TASKS = report({ paused: true });
    win.location.hash = "#/overview";
    await settle();
    win.location.hash = "#/system/scheduled";
    await settle(20);
    expect(text()).toContain("The platform is paused");
  });
});
