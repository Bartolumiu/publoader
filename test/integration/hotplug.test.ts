import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import AdmZip from "adm-zip";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/logging.js";
import { buildContext } from "../../src/core/api/context.js";
import { buildServer } from "../../src/core/api/server.js";
import { closeDb, dbReady, resetDb, testPrisma } from "./db.js";

/**
 * Extensions are data to the core, not code: it never imports or executes them.
 * These tests pin the operational consequences of that; an extension can be
 * added, removed or rolled back at any moment, and nothing about it can stop the
 * control plane from answering.
 */
describe.skipIf(!dbReady())("hot-plug extension lifecycle", () => {
  const prisma = testPrisma();
  const config = loadConfig({
    DATABASE_URL: process.env.TEST_DATABASE_URL!,
    ADMIN_TOKEN: "test-admin-token-0123456789",
    LEASE_POLL_WAIT_SECONDS: "1",
    LOG_LEVEL: "error",
  });
  const log = createLogger("test-hotplug", "error");
  let app: FastifyInstance;
  const admin = { authorization: "Bearer test-admin-token-0123456789" };

  const manifestFor = (name: string, version: string) => ({
    name,
    version,
    publoader_api: "^2.0.0",
    runtime: "node",
    entrypoint: "index.mjs",
    mangadex_group_id: "4f1de6a2-f0c5-4ac5-bce5-02c7dbb67deb",
    languages: ["en"],
    allowed_hosts: ["example.com"],
  });

  const bundleZip = (name: string, version: string, marker: string): Buffer => {
    const zip = new AdmZip();
    zip.addFile("manifest.json", Buffer.from(JSON.stringify(manifestFor(name, version))));
    zip.addFile(
      "index.mjs",
      Buffer.from(`// ${marker}\nexport default () => ({ async collect() { return {}; } });\n`),
    );
    return zip.toBuffer();
  };

  async function publish(name: string, version: string, marker = version): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/bundles",
      headers: { ...admin, "content-type": "application/zip" },
      payload: bundleZip(name, version, marker),
    });
    expect([200, 201]).toContain(res.statusCode);
    return res.json().sha256;
  }

  async function enrollWorker(extensions: string[] = []): Promise<string> {
    const mint = await app.inject({
      method: "POST",
      url: "/api/v1/admin/enroll-tokens",
      headers: admin,
      payload: { trust: "TRUSTED" },
    });
    const enroll = await app.inject({
      method: "POST",
      url: "/api/v1/worker/enroll",
      payload: { enrollToken: mint.json().token, name: `w-${Math.random()}`, extensions },
    });
    expect(enroll.statusCode).toBe(201);
    return enroll.json().workerToken;
  }

  const triggerRun = (extension: string) =>
    app.inject({
      method: "POST",
      url: "/api/v1/admin/runs",
      headers: admin,
      payload: { extension, kind: "FORCE", idempotencyKey: `t:${extension}:${Math.random()}` },
    });

  beforeEach(async () => {
    await resetDb(prisma);
    app = buildServer(buildContext(prisma, config, log));
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await closeDb();
  });

  it("loads a brand-new extension with no worker change and no core restart", async () => {
    // The worker enrols BEFORE the extension exists and declares no capability
    // list, which is what makes it able to run whatever is published later.
    const token = await enrollWorker([]);
    const headers = { authorization: `Bearer ${token}` };

    const before = await app.inject({ method: "POST", url: "/api/v1/worker/lease", headers, payload: {} });
    expect(before.statusCode).toBe(204); // nothing to do yet

    const sha = await publish("brandnew", "1.0.0");
    await triggerRun("brandnew");

    const after = await app.inject({ method: "POST", url: "/api/v1/worker/lease", headers, payload: {} });
    expect(after.statusCode).toBe(200);
    expect(after.json().job.extension).toBe("brandnew");
    expect(after.json().job.bundleSha256).toBe(sha);
  });

  it("unloading an extension cancels queued work and stops it being leased", async () => {
    await publish("goingaway", "1.0.0");
    const token = await enrollWorker();
    const headers = { authorization: `Bearer ${token}` };
    await triggerRun("goingaway");

    const disable = await app.inject({
      method: "POST",
      url: "/api/v1/admin/extensions/goingaway/disable",
      headers: { ...admin, "x-actor": "test" },
    });
    expect(disable.statusCode).toBe(200);
    // Disabled means disabled NOW: the queued job is cancelled, not left to run
    // whenever the queue happens to reach it.
    expect(disable.json().cancelled).toBe(1);

    const lease = await app.inject({ method: "POST", url: "/api/v1/worker/lease", headers, payload: {} });
    expect(lease.statusCode).toBe(204);
    const job = await prisma.job.findFirstOrThrow({ where: { extension: "goingaway" } });
    expect(job.state).toBe("CANCELLED");
  });

  it("refuses to lease a disabled extension even when a job predates the disable", async () => {
    await publish("sneaky", "1.0.0");
    const token = await enrollWorker();
    const headers = { authorization: `Bearer ${token}` };
    await triggerRun("sneaky");

    // Disable by the settings flag ALONE, leaving the job PENDING; this is the
    // state a cancellation sweep could otherwise race with.
    await prisma.disabledExtension.create({ data: { extension: "sneaky" } });

    const lease = await app.inject({ method: "POST", url: "/api/v1/worker/lease", headers, payload: {} });
    expect(lease.statusCode).toBe(204);
    expect((await prisma.job.findFirstOrThrow({ where: { extension: "sneaky" } })).state).toBe("PENDING");
  });

  it("re-enabling makes the extension runnable again", async () => {
    await publish("backagain", "1.0.0");
    const token = await enrollWorker();
    const headers = { authorization: `Bearer ${token}` };

    await app.inject({ method: "POST", url: "/api/v1/admin/extensions/backagain/disable", headers: admin });
    await app.inject({ method: "POST", url: "/api/v1/admin/extensions/backagain/enable", headers: admin });
    await triggerRun("backagain");

    const lease = await app.inject({ method: "POST", url: "/api/v1/worker/lease", headers, payload: {} });
    expect(lease.statusCode).toBe(200);
    expect(lease.json().job.extension).toBe("backagain");
  });

  it("yanking a bad version rolls back to the previous one", async () => {
    const good = await publish("rollme", "1.0.0", "good");
    const bad = await publish("rollme", "1.1.0", "bad");
    expect(bad).not.toBe(good);

    const yank = await app.inject({
      method: "POST",
      url: "/api/v1/admin/bundles/rollme/1.1.0/yank",
      headers: { ...admin, "x-actor": "test" },
      payload: { cancelPinned: true },
    });
    expect(yank.statusCode).toBe(200);
    expect(yank.json().nowLatest.version).toBe("1.0.0");

    // A new run now pins the older, known-good bundle.
    await triggerRun("rollme");
    const job = await prisma.job.findFirstOrThrow({
      where: { extension: "rollme" },
      orderBy: { createdAt: "desc" },
    });
    expect(job.bundleSha256).toBe(good);
  });

  it("yanking cancels work pinned to the bad bundle when asked", async () => {
    await publish("pinned", "1.0.0", "one");
    const badSha = await publish("pinned", "2.0.0", "two");
    await triggerRun("pinned"); // pins 2.0.0, the current latest

    const yank = await app.inject({
      method: "POST",
      url: "/api/v1/admin/bundles/pinned/2.0.0/yank",
      headers: admin,
      payload: { cancelPinned: true },
    });
    expect(yank.json().cancelled).toBe(1);
    const job = await prisma.job.findFirstOrThrow({ where: { bundleSha256: badSha } });
    expect(job.state).toBe("CANCELLED");
  });

  it("retargets a worker's extensions at runtime, with no re-enrolment", async () => {
    await publish("alpha", "1.0.0");
    await publish("beta", "1.0.0");
    // Enrolled for alpha only.
    const token = await enrollWorker(["alpha"]);
    const headers = { authorization: `Bearer ${token}` };
    const workerId = (await prisma.worker.findFirstOrThrow()).id;

    await triggerRun("beta");
    expect(
      (await app.inject({ method: "POST", url: "/api/v1/worker/lease", headers, payload: {} })).statusCode,
    ).toBe(204);

    // Operator widens the worker's remit. The stored list is what the claim
    // filters on, so this takes effect on the very next poll.
    const retarget = await app.inject({
      method: "PUT",
      url: `/api/v1/admin/workers/${workerId}/extensions`,
      headers: admin,
      payload: { extensions: ["alpha", "beta"] },
    });
    expect(retarget.statusCode).toBe(200);

    const lease = await app.inject({ method: "POST", url: "/api/v1/worker/lease", headers, payload: {} });
    expect(lease.statusCode).toBe(200);
    expect(lease.json().job.extension).toBe("beta");
  });

  it("keeps serving every other extension when one is broken", async () => {
    // `broken`'s manifest is fine but its code is not; which the core never
    // executes, so it cannot be the core's problem. The proof that matters is
    // that a healthy extension is unaffected and the API stays responsive.
    await publish("healthy", "1.0.0");
    const zip = new AdmZip();
    zip.addFile("manifest.json", Buffer.from(JSON.stringify(manifestFor("broken", "1.0.0"))));
    zip.addFile("index.mjs", Buffer.from("export default () => { throw new Error('boom'); };\n"));
    const publishBroken = await app.inject({
      method: "POST",
      url: "/api/v1/admin/bundles",
      headers: { ...admin, "content-type": "application/zip" },
      payload: zip.toBuffer(),
    });
    expect([200, 201]).toContain(publishBroken.statusCode);

    await triggerRun("broken");
    await triggerRun("healthy");

    const token = await enrollWorker();
    const headers = { authorization: `Bearer ${token}` };
    const first = await app.inject({ method: "POST", url: "/api/v1/worker/lease", headers, payload: {} });
    expect(first.statusCode).toBe(200);

    // Control plane still healthy and still handing out the other work.
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/stats", headers: admin })).statusCode).toBe(200);
    const second = await app.inject({ method: "POST", url: "/api/v1/worker/lease", headers, payload: {} });
    expect(second.statusCode).toBe(200);
    expect([first.json().job.extension, second.json().job.extension].sort()).toEqual([
      "broken",
      "healthy",
    ]);
  });
});
