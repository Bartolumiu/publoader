// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A failure an operator has cleared stops counting, on every surface.
 *
 * Clearing an entry in the Errors feed writes an acknowledgement; the feed
 * honoured it and nothing else did, so a platform whose triage list was empty
 * still reported "13 DEAD_LETTER" on the overview tile, thirteen rows in the
 * dead-letter tab and a red upload-queue reading in the header. These tests pin
 * the rule that fixed it: outstanding means "nobody has dealt with this", and
 * the cleared remainder is shown as settled rather than hidden entirely.
 *
 * Driven like dashboardOutstanding.test.ts: the real app.js under jsdom against
 * a stubbed API. See dashboardChapters.test.ts for why app.js mounts this way.
 */

/* eslint-disable @typescript-eslint/no-explicit-any --
   The DOM lib is kept out of this program, so jsdom's globals and everything
   read back out of them are loosely typed in this file only. */
const doc: any = (globalThis as any).document;
const win: any = globalThis;

const DASHBOARD = resolve(process.cwd(), "src/core/api/dashboard");
const APP_JS = join(DASHBOARD, "app.js");
const INDEX_HTML = join(DASHBOARD, "index.html");

/** Thirteen dead-lettered jobs and ten quarantines, every one already cleared. */
const STATS = {
  paused: false,
  workers: { ACTIVE: 2 },
  jobs: { SUCCEEDED: 321, DEAD_LETTER: 13, CANCELLED: 1 },
  uploadTasks: [{ kind: "UPLOAD", state: "PENDING", count: 444 }],
  quarantined: 10,
  errorsOutstanding: { total: 0, jobs: 0, uploadTasks: 0, submissions: 0 },
};

const CLEARED_JOB = {
  id: "45a99494-0000-4000-8000-000000000001",
  runId: "6b1b2c3d-0000-4000-8000-000000000001",
  extension: "alpha_manga",
  state: "DEAD_LETTER",
  errorClass: "ContractError",
  attempt: 3,
  maxAttempts: 3,
  lastError: "job.json carries no manifest",
  updatedAt: "2026-09-01T13:05:51.000Z",
  cleared: { at: "2026-09-01T19:00:03.000Z", by: "user:ardax", note: "bundle replaced" },
};

let requested: string[] = [];

function routes(): { match: RegExp; body: unknown }[] {
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
    { match: /\/stats$/, body: STATS },
    { match: /\/runs\?limit=1/, body: { runs: [] } },
    { match: /\/runs\?/, body: { runs: [] } },
    // The default view is the to-do list: nothing outstanding, thirteen hidden.
    { match: /\/dead-letter\?cleared=without/, body: { jobs: [], clearedHidden: 13 } },
    { match: /\/dead-letter\?cleared=only/, body: { jobs: [CLEARED_JOB], clearedHidden: 0 } },
    { match: /\/dead-letter/, body: { jobs: [CLEARED_JOB], clearedHidden: 0 } },
    { match: /\/quarantine\?cleared=without/, body: { quarantined: [], clearedHidden: 10 } },
    { match: /\/quarantine/, body: { quarantined: [], clearedHidden: 0 } },
    { match: /\/errors/, body: { errors: [], clearedHidden: 23 } },
  ];
}

function installFetch(): void {
  const table = routes();
  win.fetch = vi.fn(async (url: string) => {
    const path = String(url);
    requested.push(path);
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
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

async function goto(hash: string): Promise<void> {
  win.location.hash = hash;
  await settle();
}

function cardByTitle(title: string): any {
  const cards = [...doc.querySelectorAll("section.card")];
  return cards.find((c: any) => c.querySelector("h2")?.textContent === title);
}

function tileStates(card: any): string[] {
  const grid = card?.querySelector(".grid.tight");
  if (!grid) return [];
  return [...grid.querySelectorAll(".stat .chip")].map((chip: any) => chip.textContent);
}

describe("a cleared failure stops counting everywhere", () => {
  beforeEach(async () => {
    requested = [];
    const html = readFileSync(INDEX_HTML, "utf8");
    const body = html.split("<body>")[1]?.split("</body>")[0];
    if (!body) throw new Error("index.html has no <body>: the dashboard shell cannot be mounted");
    doc.body.innerHTML = body;
    win.location.hash = "";
    installFetch();
    new Function(readFileSync(APP_JS, "utf8")).call(win);
    await settle(10);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllTimers();
  });

  it("keeps cleared dead-letters out of the overview's outstanding tiles", async () => {
    await goto("#/overview");
    const card = cardByTitle("Jobs outstanding");
    expect(card).toBeTruthy();
    // Thirteen on record, none outstanding: no tile, and no red chip.
    expect(tileStates(card)).not.toContain("DEAD_LETTER");
    expect(card.textContent).toContain("Nothing outstanding");
  });

  it("still accounts for them, as settled work rather than as a silence", async () => {
    await goto("#/overview");
    const details = cardByTitle("Jobs outstanding").querySelector("details");
    expect(details.textContent).toContain("DEAD_LETTER (cleared)");
    expect(details.textContent).toContain("13");
  });

  it("reports the quarantine as dealt with instead of as ten open faults", async () => {
    await goto("#/overview");
    const card = cardByTitle("Quarantine");
    expect(card).toBeTruthy();
    expect(card.querySelector("p.error")).toBeNull();
    expect(card.textContent).toContain("Nothing outstanding");
    expect(card.textContent).toContain("10 cleared submission(s) on record");
    // The way in is kept: cleared is not the same as gone.
    expect(card.querySelector("a").getAttribute("href")).toBe("#/errors/quarantine");
  });

  it("leaves the header's queue reading unpainted when every quarantine is cleared", async () => {
    await goto("#/overview");
    const reading = doc.getElementById("sum-queue");
    expect(reading.textContent).toBe("444");
    expect(reading.className).not.toContain("bad");
  });

  it("makes the uploads-queued reading a link into the queue", async () => {
    await goto("#/overview");
    const link = doc.getElementById("sum-queue-link");
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("#/queues/tasks");
    expect(link.getAttribute("aria-disabled")).toBeNull();
  });

  it("asks the dead-letter queue for outstanding jobs, and says what it is hiding", async () => {
    await goto("#/runs/dead-letter");
    expect(requested.some((p) => p.includes("/dead-letter?cleared=without"))).toBe(true);

    const card = cardByTitle("Dead letter");
    expect(card.textContent).toContain("13 cleared job(s) hidden");
    expect(card.textContent).toContain("Nothing is dead-lettered.");
  });

  it("can still show and replay the cleared ones", async () => {
    await goto("#/runs/dead-letter");
    const select = doc.getElementById("dead-letter-cleared");
    expect([...select.options].map((o: any) => o.value)).toEqual(["without", "with", "only"]);

    select.value = "only";
    select.dispatchEvent(new win.Event("change", { bubbles: true }));
    await settle();

    expect(requested.some((p) => p.includes("/dead-letter?cleared=only"))).toBe(true);
    const card = cardByTitle("Dead letter");
    expect(card.textContent).toContain("cleared by user:ardax");
    // Replay is still offered on a cleared job: hiding is not disabling.
    expect([...card.querySelectorAll("button")].some((b: any) => b.textContent === "Replay")).toBe(true);
  });

  it("filters the quarantine listing the same three ways", async () => {
    await goto("#/errors/quarantine");
    expect(requested.some((p) => p.includes("/quarantine?cleared=without"))).toBe(true);

    const card = cardByTitle("Quarantined result submissions");
    expect(card.textContent).toContain("10 cleared submission(s) hidden");
    expect(doc.getElementById("quarantine-cleared")).toBeTruthy();
  });
});
