import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import AdmZip from "adm-zip";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/logging.js";
import { buildContext } from "../../src/core/api/context.js";
import { buildServer } from "../../src/core/api/server.js";
import { SchedulerService } from "../../src/core/scheduler/service.js";
import { closeDb, dbReady, resetDb, testPrisma } from "./db.js";

/**
 * Multi-slot schedules, end to end through HTTP and then through a real
 * scheduler tick.
 *
 * The unit tests cover the arithmetic of one slot. What only a database can
 * answer is whether an extension carrying FOUR slots actually produces four
 * different runs on the right days: the precedence between manifest and
 * operator rows, the seeding that stops `add` deleting the manifest's schedule,
 * and the run idempotency key that has to separate an update from a clean at
 * the same minute.
 */
describe.skipIf(!dbReady())("multi-slot schedules", () => {
  const prisma = testPrisma();
  const config = loadConfig({
    DATABASE_URL: process.env.TEST_DATABASE_URL!,
    ADMIN_TOKEN: "test-admin-token-0123456789",
    LOG_LEVEL: "error",
  });
  const log = createLogger("test-schedules", "error");
  let app: FastifyInstance;

  const admin = { authorization: "Bearer test-admin-token-0123456789" };

  const manifest = {
    name: "mangaplus",
    version: "0.3.00",
    publoader_api: "^2.0.0",
    runtime: "node",
    entrypoint: "index.mjs",
    mangadex_group_id: "4f1de6a2-f0c5-4ac5-bce5-02c7dbb67deb",
    languages: ["en"],
    allowed_hosts: ["mangaplus.shueisha.co.jp"],
    // The manifest declares a plain daily update; every operator edit below
    // has to reckon with it.
    schedule: { hour: 15, minute: 0 },
  };

  const publish = async (over: object = {}): Promise<void> => {
    const zip = new AdmZip();
    zip.addFile("manifest.json", Buffer.from(JSON.stringify({ ...manifest, ...over })));
    zip.addFile("index.mjs", Buffer.from("export default () => ({ async collect() { return {}; } });\n"));
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/bundles",
      headers: { ...admin, "content-type": "application/zip" },
      payload: zip.toBuffer(),
    });
    expect([200, 201]).toContain(res.statusCode);
  };

  const get = async (path: string) => {
    const res = await app.inject({ method: "GET", url: `/api/v1/admin/schedules${path}`, headers: admin });
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  beforeEach(async () => {
    await resetDb(prisma);
    const ctx = buildContext(prisma, config, log);
    app = buildServer(ctx);
    await app.ready();
    await publish();
  });
  afterAll(async () => {
    await app?.close();
    await closeDb();
  });

  it("serves the manifest schedule until an operator says otherwise", async () => {
    const body = await get("/mangaplus");
    expect(body.source).toBe("manifest");
    expect(body.entries).toEqual([]);
    expect(body.effective).toEqual([{ hour: 15, minute: 0, days: [], kind: "UPDATE" }]);
  });

  it("a manifest may declare several slots itself", async () => {
    await publish({
      version: "0.4.00",
      schedule: [
        { hour: 15, minute: 0 },
        { hour: 1, minute: 0 },
        { hour: 1, minute: 0, day: 2, kind: "CLEAN" },
      ],
    });
    const body = await get("/mangaplus");
    expect(body.manifest).toHaveLength(3);
    expect(body.manifest[2]).toMatchObject({ hour: 1, minute: 0, days: [2], kind: "CLEAN" });
  });

  it("`add` copies the manifest slots in first, so the daily update does not vanish", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/schedules/mangaplus",
      headers: admin,
      payload: { hour: 1, minute: 0, days: [2], kind: "CLEAN", label: "weekly deep clean" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ created: true, seeded: 1 });

    const body = await get("/mangaplus");
    expect(body.source).toBe("operator");
    expect(body.effective).toEqual([
      { hour: 1, minute: 0, days: [2], kind: "CLEAN", label: "weekly deep clean" },
      { hour: 15, minute: 0, days: [], kind: "UPDATE" },
    ]);
  });

  it("adding the same slot twice is a no-op, not a second identical run", async () => {
    const payload = { hour: 1, minute: 0, days: [2], kind: "CLEAN" };
    const first = await app.inject({ method: "POST", url: "/api/v1/admin/schedules/mangaplus", headers: admin, payload });
    const second = await app.inject({ method: "POST", url: "/api/v1/admin/schedules/mangaplus", headers: admin, payload });
    expect(first.json().created).toBe(true);
    expect(second.json()).toMatchObject({ created: false, id: first.json().id });
    expect((await get("/mangaplus")).entries).toHaveLength(2);
  });

  it("`PUT` replaces the whole schedule, and a single object still means one slot", async () => {
    await app.inject({
      method: "PUT",
      url: "/api/v1/admin/schedules/mangaplus",
      headers: admin,
      payload: {
        entries: [
          { hour: 15, minute: 0 },
          { hour: 1, minute: 0 },
          { hour: 1, minute: 0, days: [2], kind: "CLEAN" },
          { hour: 0, minute: 0 },
        ],
      },
    });
    expect((await get("/mangaplus")).entries).toHaveLength(4);

    // The pre-list body shape: one slot, replacing everything.
    await app.inject({
      method: "PUT",
      url: "/api/v1/admin/schedules/mangaplus",
      headers: admin,
      payload: { hour: 6, minute: 30, day: 0 },
    });
    expect((await get("/mangaplus")).effective).toEqual([
      { hour: 6, minute: 30, days: [0], kind: "UPDATE" },
    ]);
  });

  it("a disabled slot stays in the list but leaves the effective schedule", async () => {
    await app.inject({
      method: "PUT",
      url: "/api/v1/admin/schedules/mangaplus",
      headers: admin,
      payload: { entries: [{ hour: 15, minute: 0 }, { hour: 1, minute: 0, days: [2], kind: "CLEAN" }] },
    });
    const [first] = (await get("/mangaplus")).entries;
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/schedules/mangaplus/${first.id}`,
      headers: admin,
      payload: { enabled: false },
    });
    expect(patch.statusCode).toBe(200);

    const body = await get("/mangaplus");
    expect(body.entries).toHaveLength(2);
    expect(body.effective).toHaveLength(1);
    expect(body.effective[0]).toMatchObject({ kind: "UPDATE", hour: 15 });
  });

  it("switching every slot off runs nothing; it does not fall back to the manifest", async () => {
    await app.inject({
      method: "PUT",
      url: "/api/v1/admin/schedules/mangaplus",
      headers: admin,
      payload: { entries: [{ hour: 3, minute: 0 }] },
    });
    const [only] = (await get("/mangaplus")).entries;
    await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/schedules/mangaplus/${only.id}`,
      headers: admin,
      payload: { enabled: false },
    });
    expect((await get("/mangaplus")).effective).toEqual([]);
  });

  it("`DELETE` on the collection falls back to the manifest; on a row it drops just that row", async () => {
    await app.inject({
      method: "PUT",
      url: "/api/v1/admin/schedules/mangaplus",
      headers: admin,
      payload: { entries: [{ hour: 15, minute: 0 }, { hour: 1, minute: 0 }] },
    });
    const [first] = (await get("/mangaplus")).entries;
    await app.inject({ method: "DELETE", url: `/api/v1/admin/schedules/mangaplus/${first.id}`, headers: admin });
    expect((await get("/mangaplus")).entries).toHaveLength(1);

    await app.inject({ method: "DELETE", url: "/api/v1/admin/schedules/mangaplus", headers: admin });
    const body = await get("/mangaplus");
    expect(body.source).toBe("manifest");
    expect(body.effective).toEqual([{ hour: 15, minute: 0, days: [], kind: "UPDATE" }]);
  });

  it("404s a slot id that belongs to another extension", async () => {
    await app.inject({
      method: "POST",
      url: "/api/v1/admin/schedules/mangaplus",
      headers: admin,
      payload: { hour: 4, minute: 0 },
    });
    // Two rows: the manifest's 15:00, seeded by the add, plus the 04:00 added.
    const before = (await get("/mangaplus")).entries;
    expect(before).toHaveLength(2);
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/schedules/k_manga/${before[0].id}`,
      headers: admin,
    });
    expect(res.statusCode).toBe(404);
    expect((await get("/mangaplus")).entries).toHaveLength(2);
  });

  it("a scheduler tick creates one run per due slot, with the kind each slot asked for", async () => {
    // The example this feature was built for: 15:00 update, 01:00 update,
    // Wednesday 01:00 clean, 00:00 daily update.
    await app.inject({
      method: "PUT",
      url: "/api/v1/admin/schedules/mangaplus",
      headers: admin,
      payload: {
        entries: [
          { hour: 15, minute: 0 },
          { hour: 1, minute: 0 },
          { hour: 1, minute: 0, days: [2], kind: "CLEAN", label: "weekly deep clean" },
          { hour: 0, minute: 0 },
        ],
      },
    });

    const scheduler = new SchedulerService(prisma, log, { baseSeconds: 1, maxSeconds: 2 });
    // 2026-07-29 is a Wednesday, so all four slots are in range of one tick
    // that spans the whole day. Seeding last_tick makes the window explicit
    // rather than depending on when the test happens to run.
    await prisma.setting.upsert({
      where: { key: "scheduler_last_tick" },
      create: { key: "scheduler_last_tick", value: new Date("2026-07-28T23:59:00Z").toISOString() },
      update: { value: new Date("2026-07-28T23:59:00Z").toISOString() },
    });
    await scheduler.tick(new Date("2026-07-29T16:00:00Z"));

    const runs = await prisma.run.findMany({ orderBy: { scheduledFor: "asc" } });
    expect(runs.map((r) => [r.scheduledFor?.toISOString(), r.kind])).toEqual([
      ["2026-07-29T00:00:00.000Z", "UPDATE"],
      ["2026-07-29T01:00:00.000Z", "UPDATE"],
      // Same minute as the update above, different kind: two runs, because the
      // idempotency key carries the kind.
      ["2026-07-29T01:00:00.000Z", "CLEAN"],
      ["2026-07-29T15:00:00.000Z", "UPDATE"],
    ]);

    // Ticking again over the same window must not duplicate anything.
    await scheduler.tick(new Date("2026-07-29T16:01:00Z"));
    expect(await prisma.run.count()).toBe(4);
  });

  it("the weekly clean does not fire on the other six days", async () => {
    await app.inject({
      method: "PUT",
      url: "/api/v1/admin/schedules/mangaplus",
      headers: admin,
      payload: { entries: [{ hour: 1, minute: 0 }, { hour: 1, minute: 0, days: [2], kind: "CLEAN" }] },
    });
    const scheduler = new SchedulerService(prisma, log, { baseSeconds: 1, maxSeconds: 2 });
    await prisma.setting.upsert({
      where: { key: "scheduler_last_tick" },
      create: { key: "scheduler_last_tick", value: new Date("2026-07-30T00:30:00Z").toISOString() },
      update: { value: new Date("2026-07-30T00:30:00Z").toISOString() },
    });
    // Thursday.
    await scheduler.tick(new Date("2026-07-30T02:00:00Z"));

    const runs = await prisma.run.findMany();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.kind).toBe("UPDATE");
  });
});
