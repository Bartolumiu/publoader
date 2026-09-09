import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import AdmZip from "adm-zip";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/logging.js";
import { buildContext } from "../../src/core/api/context.js";
import { buildServer } from "../../src/core/api/server.js";
import { SchedulerService } from "../../src/core/scheduler/service.js";
import { RunProcessor } from "../../src/core/processor/processor.js";
import { JobStore } from "../../src/core/store/jobs.js";
import { SettingsStore } from "../../src/core/store/settings.js";
import { closeDb, dbReady, resetDb, testPrisma } from "./db.js";

/**
 * What a pause is worth: NOTHING runs, including what was already running.
 *
 * The gates that only stop the NEXT thing were never enough. A catalogue scrape
 * runs for tens of minutes, a processor tick for ten runs, and the GitHub poll
 * publishes extension code on its own schedule -- so an operator who paused and
 * watched the platform keep hitting publishers, queueing deletes and changing
 * its own code had every reason to believe the button did nothing.
 */
describe.skipIf(!dbReady())("pause stops everything", () => {
  const prisma = testPrisma();
  const config = loadConfig({
    DATABASE_URL: process.env.TEST_DATABASE_URL!,
    ADMIN_TOKEN: "test-admin-token-0123456789",
    LEASE_POLL_WAIT_SECONDS: "1",
    LOG_LEVEL: "error",
  });
  const log = createLogger("test-pause", "error");
  const settings = new SettingsStore(prisma);
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
    allowed_hosts: ["jumpg-webapi.tokyo-cdn.com"],
  };

  const makeBundleZip = (): Buffer => {
    const zip = new AdmZip();
    zip.addFile("manifest.json", Buffer.from(JSON.stringify(manifest)));
    zip.addFile(
      "index.mjs",
      Buffer.from("export default () => ({ async collect() { return {}; } });\n"),
    );
    return zip.toBuffer();
  };

  beforeEach(async () => {
    await resetDb(prisma);
    app = buildServer(buildContext(prisma, config, log));
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await closeDb();
  });

  const pause = () => settings.setPauseUntil(Infinity);

  /** Publish, enrol, start a run, and take the lease -- all before any pause. */
  async function leaseAJob(): Promise<{ jobId: string; leaseId: string; headers: Record<string, string> }> {
    await app.inject({
      method: "POST",
      url: "/api/v1/admin/bundles",
      headers: { ...admin, "content-type": "application/zip" },
      payload: makeBundleZip(),
    });
    const mint = await app.inject({
      method: "POST",
      url: "/api/v1/admin/enroll-tokens",
      headers: admin,
      payload: { trust: "TRUSTED" },
    });
    const enroll = await app.inject({
      method: "POST",
      url: "/api/v1/worker/enroll",
      payload: { enrollToken: mint.json().token, name: "test-worker" },
    });
    const headers = { authorization: `Bearer ${enroll.json().workerToken}` };
    await app.inject({
      method: "POST",
      url: "/api/v1/admin/runs",
      headers: admin,
      payload: { extension: "mangaplus", kind: "UPDATE" },
    });
    const lease = await app.inject({ method: "POST", url: "/api/v1/worker/lease", headers, payload: {} });
    expect(lease.statusCode).toBe(200);
    return { jobId: lease.json().job.jobId, leaseId: lease.json().leaseId, headers };
  }

  it("hands out no lease, and tells the worker to idle rather than poll every second", async () => {
    const { headers } = await leaseAJob();
    await pause();
    const res = await app.inject({ method: "POST", url: "/api/v1/worker/lease", headers, payload: {} });
    expect(res.statusCode).toBe(204);
    // The agent sleeps a minute on this header and one second without it.
    expect(res.headers["x-publoader-drained"]).toBe("true");
  });

  it("refuses to start a job that was leased in the moment before the pause, and hands it back", async () => {
    const { jobId, leaseId, headers } = await leaseAJob();
    await pause();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/worker/jobs/${jobId}/start`,
      headers,
      payload: { leaseId },
    });
    expect(res.statusCode).toBe(409);
    // Not left LEASED for the sweeper to expire in ten minutes' time.
    expect(await prisma.job.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({
      state: "PENDING",
      leaseId: null,
    });
  });

  it("stops a job that is ALREADY RUNNING, through the renew the worker is already making", async () => {
    const { jobId, leaseId, headers } = await leaseAJob();
    const renew = () =>
      app.inject({ method: "POST", url: `/api/v1/worker/jobs/${jobId}/renew`, headers, payload: { leaseId } });

    await app.inject({
      method: "POST",
      url: `/api/v1/worker/jobs/${jobId}/start`,
      headers,
      payload: { leaseId },
    });
    expect((await renew()).statusCode).toBe(200);

    await pause();
    // The agent treats this exactly as a lost lease: it aborts the runner and
    // abandons the job without submitting anything.
    expect((await renew()).statusCode).toBe(409);

    const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job).toMatchObject({ state: "PENDING", leaseId: null });
    // A pause is not the job's fault: the attempt the claim took is given back,
    // so pausing during a run's last attempt cannot dead-letter it, and it is
    // not flagged in a way that would keep it unclaimable after the resume.
    expect(job.attempt).toBe(0);
    expect(job.cancelRequested).toBe(false);

    // And once resumed, the job is simply there to be claimed again.
    await settings.setPauseUntil(0);
    const again = await app.inject({ method: "POST", url: "/api/v1/worker/lease", headers, payload: {} });
    expect(again.statusCode).toBe(200);
    expect(again.json().job.jobId).toBe(jobId);
  });

  it("does not poll GitHub or publish extension code", async () => {
    const autoSync = vi.fn().mockResolvedValue([]);
    const scheduler = new SchedulerService(prisma, log, { baseSeconds: 1, maxSeconds: 2 }, { autoSync });

    await pause();
    await scheduler.tick();
    expect(autoSync).not.toHaveBeenCalled();

    await settings.setPauseUntil(0);
    await scheduler.tick();
    expect(autoSync).toHaveBeenCalledOnce();
  });

  it("claims no run to process, leaving it where the resume will find it", async () => {
    const jobs = new JobStore(prisma, { baseSeconds: 1, maxSeconds: 2 });
    const { run } = await jobs.createRun({
      idempotencyKey: "pause-run-1",
      extension: "mangaplus",
      extensionVersion: "0.3.00",
      bundleSha256: "a".repeat(64),
      kind: "UPDATE",
    });
    const ingesting = await prisma.run.update({
      where: { id: run.id },
      data: { state: "INGESTING" },
    });

    // MangaDex is never reached: the gate is ahead of the claim, so a stub with
    // nothing on it is itself part of the assertion.
    const processor = new RunProcessor(prisma, {} as never, log, { botUserId: "bot" });

    await pause();
    expect(await processor.tick()).toBe(0);
    const after = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.state).toBe("INGESTING");
    // The run was not even CLAIMED. `claimRun` bumps `updated_at`, so an
    // untouched timestamp is the difference between a gate that stops the work
    // and one that merely lets it fail on a stub.
    expect(after.updatedAt).toEqual(ingesting.updatedAt);
  });
});
