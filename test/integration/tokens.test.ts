import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import AdmZip from "adm-zip";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/logging.js";
import { buildContext } from "../../src/core/api/context.js";
import { buildServer } from "../../src/core/api/server.js";
import { closeDb, dbReady, resetDb, testPrisma } from "./db.js";

/**
 * Blast-radius containment: a scoped token must reach its own area and nothing
 * else. These tests are the evidence for the security claim, so they assert
 * both halves; the permitted call succeeds AND the neighbouring areas 403.
 */
describe.skipIf(!dbReady())("scoped api tokens", () => {
  const prisma = testPrisma();
  const config = loadConfig({
    DATABASE_URL: process.env.TEST_DATABASE_URL!,
    ADMIN_TOKEN: "test-admin-token-0123456789",
    LOG_LEVEL: "error",
  });
  const log = createLogger("test-tokens", "error");
  let app: FastifyInstance;
  const root = { authorization: "Bearer test-admin-token-0123456789" };

  beforeEach(async () => {
    await resetDb(prisma);
    app = buildServer(buildContext(prisma, config, log));
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await closeDb();
  });

  async function mint(scopes: string[], ttlDays?: number): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/tokens",
      headers: root,
      payload: { name: `t-${scopes.join("-")}`, scopes, ...(ttlDays ? { ttlDays } : {}) },
    });
    expect(res.statusCode).toBe(201);
    return res.json().token;
  }

  const bundleZip = (): Buffer => {
    const zip = new AdmZip();
    zip.addFile(
      "manifest.json",
      Buffer.from(
        JSON.stringify({
          name: "scopetest",
          version: "1.0.0",
          publoader_api: "^2.0.0",
          runtime: "node",
          entrypoint: "index.mjs",
          mangadex_group_id: "4f1de6a2-f0c5-4ac5-bce5-02c7dbb67deb",
          languages: ["en"],
          allowed_hosts: ["example.com"],
        }),
      ),
    );
    zip.addFile("index.mjs", Buffer.from("export default () => ({ async collect() { return {}; } });\n"));
    return zip.toBuffer();
  };

  it("mints once and never reveals the secret again", async () => {
    const token = await mint(["stats:read"]);
    expect(token.startsWith("pa_")).toBe(true);
    const list = await app.inject({ method: "GET", url: "/api/v1/admin/tokens", headers: root });
    const body = JSON.stringify(list.json());
    expect(body).not.toContain(token);
    expect(body).not.toContain("tokenHash");
  });

  it("confines a token to its area", async () => {
    const token = await mint(["stats:read"]);
    const headers = { authorization: `Bearer ${token}` };

    expect((await app.inject({ method: "GET", url: "/api/v1/admin/stats", headers })).statusCode).toBe(200);

    for (const url of [
      "/api/v1/admin/workers",
      "/api/v1/admin/extensions",
      "/api/v1/admin/audit",
      "/api/v1/admin/untracked",
    ]) {
      const res = await app.inject({ method: "GET", url, headers });
      expect(res.statusCode, `${url} should be forbidden`).toBe(403);
      expect(res.json().error).toMatch(/missing scope/);
    }
    const write = await app.inject({
      method: "POST",
      url: "/api/v1/admin/pause",
      headers,
      payload: {},
    });
    expect(write.statusCode).toBe(403);
  });

  it("write implies read within one area but grants nothing next door", async () => {
    const token = await mint(["runs:write"]);
    const headers = { authorization: `Bearer ${token}` };
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/runs", headers })).statusCode).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/admin/dead-letter", headers })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/admin/workers", headers })).statusCode,
    ).toBe(403);
  });

  it("a publisher token can publish bundles and do nothing else", async () => {
    const token = await mint(["bundles:write"]);
    const headers = { authorization: `Bearer ${token}` };
    const publish = await app.inject({
      method: "POST",
      url: "/api/v1/admin/bundles",
      headers: { ...headers, "content-type": "application/zip" },
      payload: bundleZip(),
    });
    expect([200, 201]).toContain(publish.statusCode);
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/admin/workers", headers })).statusCode,
    ).toBe(403);
  });

  it("no token, however broadly scoped, can mint or widen credentials", async () => {
    const wildcard = await mint(["*"]);
    const headers = { authorization: `Bearer ${wildcard}` };
    // Wildcard reaches operational areas...
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/stats", headers })).statusCode).toBe(200);
    // ...but credential minting and account administration stay owner-only.
    const escalate = await app.inject({
      method: "POST",
      url: "/api/v1/admin/tokens",
      headers,
      payload: { name: "self-escalated", scopes: ["*"] },
    });
    expect(escalate.statusCode).toBe(403);
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/admin/users", headers })).statusCode,
    ).toBe(403);
  });

  it("revoked and expired tokens stop working", async () => {
    const token = await mint(["stats:read"]);
    const headers = { authorization: `Bearer ${token}` };
    const id = (await app.inject({ method: "GET", url: "/api/v1/admin/tokens", headers: root }))
      .json()
      .tokens[0].id;

    expect((await app.inject({ method: "GET", url: "/api/v1/admin/stats", headers })).statusCode).toBe(200);
    const revoke = await app.inject({
      method: "POST",
      url: `/api/v1/admin/tokens/${id}/revoke`,
      headers: root,
    });
    expect(revoke.statusCode).toBe(200);
    const after = await app.inject({ method: "GET", url: "/api/v1/admin/stats", headers });
    expect(after.statusCode).toBe(401);

    // Expiry is enforced on read, not by a sweeper.
    const expiring = await mint(["stats:read"], 1);
    await prisma.apiToken.updateMany({
      where: { tokenHash: { not: "" }, revoked: false },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const expired = await app.inject({
      method: "GET",
      url: "/api/v1/admin/stats",
      headers: { authorization: `Bearer ${expiring}` },
    });
    expect(expired.statusCode).toBe(401);
  });

  it("rejects unknown scopes at mint time", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/tokens",
      headers: root,
      payload: { name: "typo", scopes: ["run:write"] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().validScopes).toContain("runs:write");
  });

  it("records the token name as the audit actor, not a shared identity", async () => {
    const token = await mint(["settings:write"]);
    await app.inject({
      method: "POST",
      url: "/api/v1/admin/pause",
      headers: { authorization: `Bearer ${token}` },
      payload: { minutes: 5 },
    });
    const events = await prisma.auditEvent.findMany({ where: { action: "platform.pause" } });
    expect(events[0]?.actor).toBe("token:t-settings:write");
  });
});
