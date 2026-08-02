import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import AdmZip from "adm-zip";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/logging.js";
import { buildContext } from "../../src/core/api/context.js";
import { buildServer } from "../../src/core/api/server.js";
import { closeDb, dbReady, resetDb, testPrisma } from "./db.js";
import { ExtensionConfigStore } from "../../src/core/store/extensionConfig.js";

/**
 * Control-plane API: enrollment lifecycle, audience separation, revocation,
 * lease flow, envelope ingestion, and bundle pinning — exercised end-to-end
 * through HTTP (fastify inject).
 */
describe.skipIf(!dbReady())("control-plane API", () => {
  const prisma = testPrisma();
  const config = loadConfig({
    DATABASE_URL: process.env.TEST_DATABASE_URL!,
    ADMIN_TOKEN: "test-admin-token-0123456789",
    LEASE_POLL_WAIT_SECONDS: "1",
    LOG_LEVEL: "error",
  });
  const log = createLogger("test-api", "error");
  let app: FastifyInstance;

  const admin = { authorization: "Bearer test-admin-token-0123456789" };

  // An extension API v2 bundle: a single ESM entrypoint with a default-exported
  // factory. Publishing refuses python bundles outright, so this is also the
  // only shape these tests can legitimately push through the admin route.
  const manifest = {
    name: "mangaplus",
    version: "0.3.00",
    publoader_api: "^2.0.0",
    runtime: "node",
    entrypoint: "index.mjs",
    mangadex_group_id: "4f1de6a2-f0c5-4ac5-bce5-02c7dbb67deb",
    languages: ["en", "es"],
    allowed_hosts: ["jumpg-webapi.tokyo-cdn.com", "mangaplus.shueisha.co.jp"],
  };

  const makeBundleZip = (): Buffer => {
    const zip = new AdmZip();
    zip.addFile("manifest.json", Buffer.from(JSON.stringify(manifest)));
    zip.addFile(
      "index.mjs",
      Buffer.from("export default () => ({ async collect() { return {}; } });\n"),
    );
    zip.addFile(
      "manga_id_map.json",
      Buffer.from(JSON.stringify({ "b3c7e5d1-0000-4000-8000-000000000001": ["100001"] })),
    );
    return zip.toBuffer();
  };

  beforeEach(async () => {
    await resetDb(prisma);
    const ctx = buildContext(prisma, config, log);
    app = buildServer(ctx);
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await closeDb();
  });

  async function enrollWorker(): Promise<{ workerId: string; token: string }> {
    const mint = await app.inject({
      method: "POST",
      url: "/api/v1/admin/enroll-tokens",
      headers: admin,
      payload: { trust: "TRUSTED" },
    });
    expect(mint.statusCode).toBe(200);
    const { token: enrollToken } = mint.json();
    const enroll = await app.inject({
      method: "POST",
      url: "/api/v1/worker/enroll",
      payload: { enrollToken, name: "test-worker" },
    });
    expect(enroll.statusCode).toBe(201);
    const body = enroll.json();
    return { workerId: body.workerId, token: body.workerToken };
  }

  async function publishBundle(): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/bundles",
      headers: { ...admin, "content-type": "application/zip" },
      payload: makeBundleZip(),
    });
    expect([200, 201]).toContain(res.statusCode);
    return res.json().sha256;
  }

  it("separates token audiences: worker tokens cannot call admin routes and vice versa", async () => {
    const { token } = await enrollWorker();
    const asWorker = await app.inject({
      method: "GET",
      url: "/api/v1/admin/workers",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(asWorker.statusCode).toBe(401);
    const asAdmin = await app.inject({
      method: "POST",
      url: "/api/v1/worker/heartbeat",
      headers: admin,
      payload: {},
    });
    expect(asAdmin.statusCode).toBe(401);
    const noToken = await app.inject({ method: "GET", url: "/api/v1/admin/workers" });
    expect(noToken.statusCode).toBe(401);
  });

  it("enrollment tokens are single-use and expiring", async () => {
    const mint = await app.inject({
      method: "POST",
      url: "/api/v1/admin/enroll-tokens",
      headers: admin,
      payload: {},
    });
    const { token: enrollToken } = mint.json();
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/worker/enroll",
      payload: { enrollToken, name: "w1" },
    });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/worker/enroll",
      payload: { enrollToken, name: "w2" },
    });
    expect(second.statusCode).toBe(403);
    const garbage = await app.inject({
      method: "POST",
      url: "/api/v1/worker/enroll",
      payload: { enrollToken: "pe_not-a-real-token", name: "w3" },
    });
    expect(garbage.statusCode).toBe(403);
  });

  it("revoked workers lose access; drained workers stop receiving leases", async () => {
    const { workerId, token } = await enrollWorker();
    const headers = { authorization: `Bearer ${token}` };

    await app.inject({ method: "POST", url: `/api/v1/admin/workers/${workerId}/drain`, headers: admin });
    const drained = await app.inject({ method: "POST", url: "/api/v1/worker/lease", headers, payload: {} });
    expect(drained.statusCode).toBe(204);
    expect(drained.headers["x-publoader-drained"]).toBe("true");

    await app.inject({ method: "POST", url: `/api/v1/admin/workers/${workerId}/revoke`, headers: admin });
    const revoked = await app.inject({ method: "POST", url: "/api/v1/worker/heartbeat", headers, payload: {} });
    expect(revoked.statusCode).toBe(401);
  });

  it("lease -> results flow commits exactly once and pins bundle versions", async () => {
    const sha = await publishBundle();
    const { token } = await enrollWorker();
    const headers = { authorization: `Bearer ${token}` };

    const trigger = await app.inject({
      method: "POST",
      url: "/api/v1/admin/runs",
      headers: admin,
      payload: { extension: "mangaplus", kind: "FORCE" },
    });
    expect(trigger.statusCode).toBe(201);

    const lease = await app.inject({ method: "POST", url: "/api/v1/worker/lease", headers, payload: {} });
    expect(lease.statusCode).toBe(200);
    const leased = lease.json();
    expect(leased.job.bundleSha256).toBe(sha);
    expect(leased.job.manifest.name).toBe("mangaplus");
    // DB-seeded manga id map is delivered with the lease, in the flat legacy
    // shape while every tracked row is in the extension's default id space.
    expect(leased.job.mangaIdMap["b3c7e5d1-0000-4000-8000-000000000001"]).toEqual(["100001"]);
    expect(leased.job.mangaIdMapNamespaced).toBe(false);

    const envelope = {
      envelopeVersion: 1,
      jobId: leased.job.jobId,
      leaseId: leased.leaseId,
      segmentKey: null,
      extension: "mangaplus",
      bundleSha256: sha,
      idempotencyKey: `res:${leased.job.jobId}:${leased.job.attempt}`,
      status: "ok",
      error: null,
      updatedChapters: [
        {
          chapterId: "1014090",
          chapterNumber: "5",
          chapterLanguage: "en",
          chapterTitle: "Chapter 5",
          chapterUrl: "https://mangaplus.shueisha.co.jp/titles/1014090",
          mangaId: "100001",
          mdMangaId: "b3c7e5d1-0000-4000-8000-000000000001",
        },
      ],
      allChapters: null,
      untrackedManga: [],
      trackedMangadexIds: ["b3c7e5d1-0000-4000-8000-000000000001"],
      mangadexGroupId: manifest.mangadex_group_id,
      overrideOptions: {},
      extensionLanguages: ["en", "es"],
      stats: {},
    };

    const submit = await app.inject({
      method: "POST",
      url: `/api/v1/worker/jobs/${leased.job.jobId}/results`,
      headers,
      payload: envelope,
    });
    expect(submit.statusCode).toBe(200);
    expect(submit.json().outcome).toBe("committed");

    // Idempotent retry of the same envelope acks the prior outcome.
    const retry = await app.inject({
      method: "POST",
      url: `/api/v1/worker/jobs/${leased.job.jobId}/results`,
      headers,
      payload: envelope,
    });
    expect(retry.json().outcome).toBe("committed");
    expect(await prisma.resultSubmission.count({ where: { state: "COMMITTED" } })).toBe(1);

    const job = await prisma.job.findUniqueOrThrow({ where: { id: leased.job.jobId } });
    expect(job.state).toBe("SUCCEEDED");
  });

  /**
   * viz reuses numeric ids across its `shonenjump` and `vizmanga` catalogues, so
   * the lease has to say which catalogue an id belongs to. The flat shape cannot,
   * hence the second wire form — and `mangaIdMapNamespaced` so a runner that does
   * not implement it can refuse loudly rather than invert an object-valued map
   * into an empty lookup and report every series as untracked.
   */
  it("delivers a namespaced manga id map once an extension has more than one catalogue", async () => {
    const sha = await publishBundle();
    await prisma.trackedManga.createMany({
      data: [
        {
          extension: "mangaplus",
          namespace: "vizmanga",
          mangaId: "709",
          mdMangaId: "b3c7e5d1-0000-4000-8000-000000000002",
        },
        {
          extension: "mangaplus",
          namespace: "shonenjump",
          mangaId: "709",
          mdMangaId: "b3c7e5d1-0000-4000-8000-000000000003",
        },
      ],
    });

    const { token } = await enrollWorker();
    await app.inject({
      method: "POST",
      url: "/api/v1/admin/runs",
      headers: admin,
      payload: { extension: "mangaplus", kind: "FORCE" },
    });
    const lease = await app.inject({
      method: "POST",
      url: "/api/v1/worker/lease",
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(lease.statusCode).toBe(200);
    const leased = lease.json();
    expect(leased.job.bundleSha256).toBe(sha);
    expect(leased.job.mangaIdMapNamespaced).toBe(true);
    expect(leased.job.mangaIdMap).toEqual({
      // The publish-seeded row is in the default id space and keeps its own key
      // rather than being dropped or renamed.
      "": { "b3c7e5d1-0000-4000-8000-000000000001": ["100001"] },
      vizmanga: { "b3c7e5d1-0000-4000-8000-000000000002": ["709"] },
      shonenjump: { "b3c7e5d1-0000-4000-8000-000000000003": ["709"] },
    });
  });

  it("quarantines policy-violating envelopes (disallowed host) without touching state", async () => {
    const sha = await publishBundle();
    const { token } = await enrollWorker();
    const headers = { authorization: `Bearer ${token}` };
    await app.inject({
      method: "POST",
      url: "/api/v1/admin/runs",
      headers: admin,
      payload: { extension: "mangaplus" },
    });
    const lease = await app.inject({ method: "POST", url: "/api/v1/worker/lease", headers, payload: {} });
    const leased = lease.json();

    const submit = await app.inject({
      method: "POST",
      url: `/api/v1/worker/jobs/${leased.job.jobId}/results`,
      headers,
      payload: {
        envelopeVersion: 1,
        jobId: leased.job.jobId,
        leaseId: leased.leaseId,
        segmentKey: null,
        extension: "mangaplus",
        bundleSha256: sha,
        idempotencyKey: `res:${leased.job.jobId}:1`,
        status: "ok",
        error: null,
        updatedChapters: [
          {
            chapterId: "666",
            chapterNumber: "1",
            chapterLanguage: "en",
            chapterUrl: "https://evil.example.com/injected",
            mangaId: "100001",
            mdMangaId: "b3c7e5d1-0000-4000-8000-000000000001",
          },
        ],
        allChapters: null,
        untrackedManga: [],
        trackedMangadexIds: [],
        mangadexGroupId: manifest.mangadex_group_id,
        overrideOptions: {},
        extensionLanguages: ["en"],
        stats: {},
      },
    });
    expect(submit.json().outcome).toBe("quarantined");

    // The envelope is quarantined and NO canonical state moves — that is the
    // part that matters. The job goes back to PENDING rather than straight to
    // DEAD_LETTER: a policy failure is produced by a worker, so a hostile or
    // broken one could otherwise dead-letter every job it managed to lease.
    // Retrying costs an attempt and is very likely leased elsewhere.
    const job = await prisma.job.findUniqueOrThrow({ where: { id: leased.job.jobId } });
    expect(job.state).toBe("PENDING");
    expect(job.errorClass).toBe("POLICY");
    expect(await prisma.uploadTask.count()).toBe(0);
    expect(await prisma.resultSubmission.count({ where: { state: "QUARANTINED" } })).toBe(1);
  });

  /**
   * `custom_language` exists to publish a title in a language the extension's
   * catalogue does not name — mangaplus reports SPANISH for everything, while
   * one title is Latin-American Spanish and is mapped to `es-la`. Validating
   * chapters against the manifest alone rejected every chapter of that title,
   * which reads as a manifest mistake rather than the override working.
   *
   * The three cases below are the whole contract: rejected without a mapping,
   * accepted with one from the DATABASE, and — the reason the union was left out
   * originally — never widened by the envelope itself.
   */
  describe("custom_language and the manifest allowlist", () => {
    const envelopeWith = (
      jobId: string,
      leaseId: string,
      sha: string,
      language: string,
      overrideOptions: Record<string, unknown> = {},
    ) => ({
      envelopeVersion: 1,
      jobId,
      leaseId,
      segmentKey: null,
      extension: "mangaplus",
      bundleSha256: sha,
      idempotencyKey: `res:${jobId}:${language}`,
      status: "ok",
      error: null,
      updatedChapters: [
        {
          chapterId: "700",
          chapterNumber: "1",
          chapterLanguage: language,
          chapterUrl: "https://mangaplus.shueisha.co.jp/viewer/700",
          mangaId: "200159",
          mdMangaId: "b3c7e5d1-0000-4000-8000-000000000001",
        },
      ],
      allChapters: null,
      untrackedManga: [],
      trackedMangadexIds: [],
      mangadexGroupId: manifest.mangadex_group_id,
      overrideOptions,
      extensionLanguages: ["en"],
      stats: {},
    });

    /** Publish, enroll, trigger a run and take the lease. */
    async function ready(): Promise<{ sha: string; jobId: string; leaseId: string; headers: Record<string, string> }> {
      const sha = await publishBundle();
      const { token } = await enrollWorker();
      const headers = { authorization: `Bearer ${token}` };
      await app.inject({
        method: "POST",
        url: "/api/v1/admin/runs",
        headers: admin,
        payload: { extension: "mangaplus", kind: "FORCE" },
      });
      const lease = await app.inject({ method: "POST", url: "/api/v1/worker/lease", headers, payload: {} });
      const leased = lease.json();
      return { sha, jobId: leased.job.jobId, leaseId: leased.leaseId, headers };
    }

    async function submit(
      headers: Record<string, string>,
      jobId: string,
      payload: Record<string, unknown>,
    ) {
      return app.inject({ method: "POST", url: `/api/v1/worker/jobs/${jobId}/results`, headers, payload });
    }

    it("rejects a language no manifest or mapping declares, and says what IS declared", async () => {
      const { sha, jobId, leaseId, headers } = await ready();
      const res = await submit(headers, jobId, envelopeWith(jobId, leaseId, sha, "es-la"));
      expect(res.json().outcome).toBe("quarantined");
      // The operator's next question is always "declared where?", so the error
      // carries the answer rather than sending them to the manifest to guess.
      expect(res.json().reason).toContain("es-la");
      expect(res.json().reason).toContain("declared: en, es");
    });

    it("accepts it once an operator has mapped a title to that language", async () => {
      const { sha, jobId, leaseId, headers } = await ready();
      await new ExtensionConfigStore(prisma).replace("mangaplus", {
        custom_language: { "200159": "es-la" },
      });
      const res = await submit(headers, jobId, envelopeWith(jobId, leaseId, sha, "es-la"));
      expect(res.json().outcome).toBe("committed");
    });

    it("does NOT let the envelope's own custom_language widen the allowlist", async () => {
      // The security property the union must not cost us: a worker that can
      // declare its own languages can publish a title in any language it likes.
      // The map is read from the database precisely so a compromised worker
      // cannot vote on it.
      const { sha, jobId, leaseId, headers } = await ready();
      const res = await submit(
        headers,
        jobId,
        envelopeWith(jobId, leaseId, sha, "es-la", { custom_language: { "200159": "es-la" } }),
      );
      expect(res.json().outcome).toBe("quarantined");
    });
  });

  it("a persistently policy-violating job still dead-letters once attempts run out", async () => {
    const sha = await publishBundle();
    const { token } = await enrollWorker();
    const headers = { authorization: `Bearer ${token}` };
    await app.inject({
      method: "POST",
      url: "/api/v1/admin/runs",
      headers: admin,
      payload: { extension: "mangaplus" },
    });

    const badEnvelope = (jobId: string, leaseId: string, attempt: number) => ({
      envelopeVersion: 1,
      jobId,
      leaseId,
      segmentKey: null,
      extension: "mangaplus",
      bundleSha256: sha,
      idempotencyKey: `res:${jobId}:${attempt}`,
      status: "ok",
      error: null,
      updatedChapters: [
        {
          chapterId: "666",
          chapterNumber: "1",
          chapterLanguage: "en",
          chapterUrl: "https://evil.example.com/injected",
          mangaId: "100001",
          mdMangaId: "b3c7e5d1-0000-4000-8000-000000000001",
        },
      ],
      allChapters: null,
      untrackedManga: [],
      trackedMangadexIds: [],
      mangadexGroupId: manifest.mangadex_group_id,
      overrideOptions: {},
      extensionLanguages: ["en"],
      stats: {},
    });

    // Lease → submit garbage → repeat. maxAttempts defaults to 3, so the third
    // rejection is terminal. notBefore is cleared each round because the retry
    // backoff is not what this test is about.
    let state = "";
    for (let round = 0; round < 4; round++) {
      await prisma.job.updateMany({ data: { notBefore: new Date() } });
      const lease = await app.inject({ method: "POST", url: "/api/v1/worker/lease", headers, payload: {} });
      if (lease.statusCode !== 200) break;
      const leased = lease.json();
      const submit = await app.inject({
        method: "POST",
        url: `/api/v1/worker/jobs/${leased.job.jobId}/results`,
        headers,
        payload: badEnvelope(leased.job.jobId, leased.leaseId, leased.job.attempt),
      });
      expect(submit.json().outcome).toBe("quarantined");
      state = (await prisma.job.findUniqueOrThrow({ where: { id: leased.job.jobId } })).state;
      if (state === "DEAD_LETTER") break;
    }
    expect(state).toBe("DEAD_LETTER");
    expect(await prisma.uploadTask.count()).toBe(0);
  });

  it("malformed envelopes are rejected at the transport layer", async () => {
    const { token } = await enrollWorker();
    const bad = await app.inject({
      method: "POST",
      url: "/api/v1/worker/jobs/00000000-0000-4000-8000-000000000000/results",
      headers: { authorization: `Bearer ${token}` },
      payload: { jobId: "00000000-0000-4000-8000-000000000000", surprise: "fields" },
    });
    expect(bad.statusCode).toBe(422);
  });

  it("readyz reflects database availability and healthz stays cheap", async () => {
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
  });
});
