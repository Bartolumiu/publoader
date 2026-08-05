import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/logging.js";
import { buildContext, type AppContext } from "../../src/core/api/context.js";
import { buildServer } from "../../src/core/api/server.js";
import { MagicLinkService } from "../../src/core/api/magicLink.js";
import type { Mailer, OutgoingEmail } from "../../src/core/email/mailer.js";
import { closeDb, dbReady, resetDb, testPrisma } from "./db.js";

/**
 * Email sign-in links, end to end against a real database.
 *
 * The claims worth holding down here are the ones a unit test cannot reach,
 * because they are properties of the *row*: a link works exactly once, a newer
 * link retires an older one, setting a password retires all of them, and a link
 * for an unapproved account does not become a session. Each of those is a way
 * an emailed credential outlives its welcome.
 */

/** Captures what would have been sent, so nothing leaves the process. */
class FakeMailer implements Mailer {
  readonly enabled = true;
  readonly sent: OutgoingEmail[] = [];
  failNext = false;

  async send(email: OutgoingEmail): Promise<string> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("provider is on fire");
    }
    this.sent.push(email);
    return `msg_${this.sent.length}`;
  }
}

describe.skipIf(!dbReady())("email sign-in links", () => {
  const prisma = testPrisma();
  // RESEND_API_KEY is blanked deliberately: a developer with a real key in
  // their shell would otherwise build a mailer that talks to Resend, and the
  // "no mailer configured" case below would silently stop testing anything.
  const config = loadConfig({
    DATABASE_URL: process.env.TEST_DATABASE_URL!,
    ADMIN_TOKEN: "test-admin-token-0123456789",
    DASH_PUBLIC_URL: "https://publoader.test",
    RESEND_API_KEY: "",
    LOG_LEVEL: "error",
  });
  const log = createLogger("test-magic-link", "error");
  const root = { authorization: "Bearer test-admin-token-0123456789" };

  let app: FastifyInstance;
  let ctx: AppContext;
  let mailer: FakeMailer;

  beforeEach(async () => {
    await resetDb(prisma);
    mailer = new FakeMailer();
    ctx = buildContext(prisma, config, log);
    // The deployment under test has email configured; swap the transport, not
    // the policy, so the routes take exactly the path they take in production.
    ctx.mailer = mailer;
    ctx.magicLinks = new MagicLinkService({ loginTokens: ctx.loginTokens, mailer, config, log });
    app = buildServer(ctx);
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await closeDb();
  });

  /** The secret half of the most recent link, taken out of the mailed URL. */
  const lastToken = (): string => {
    const body = mailer.sent.at(-1)!.text;
    const match = /#token=([\w.~-]+)/.exec(body);
    expect(match, "the mailed body should contain a link").not.toBeNull();
    return match![1]!;
  };

  /** The most recent message, asserted to exist. */
  const lastMail = () => {
    const mail = mailer.sent.at(-1);
    expect(mail, "a message should have been sent").toBeDefined();
    return mail!;
  };

  const invite = async (email: string, role = "ADMIN") => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/users",
      headers: root,
      payload: { email, role },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  };

  const redeem = (token: string) =>
    app.inject({ method: "POST", url: "/api/v1/admin/session/magic-link", payload: { token } });

  const request = (email: string) =>
    app.inject({ method: "POST", url: "/api/v1/admin/session/magic-link/request", payload: { email } });

  // ---- invites ----

  it("mails a sign-in link when an owner invites somebody", async () => {
    const body = await invite("new@example.com");
    expect(body.emailed).toBe(true);
    expect(body.user.hasPassword).toBe(false);
    expect(mailer.sent).toHaveLength(1);
    expect(lastMail().to).toBe("new@example.com");
    expect(lastMail().subject).toMatch(/invited/i);
    expect(lastMail().text).toContain("https://publoader.test/#token=");
  });

  it("keeps the account when the mail fails, and says so", async () => {
    mailer.failNext = true;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/users",
      headers: root,
      payload: { email: "unreachable@example.com" },
    });
    // The account is the durable half of the action; the link can be re-sent.
    expect(res.statusCode).toBe(201);
    expect(res.json().emailed).toBe(false);
    expect(res.json().emailError).toMatch(/on fire/);
    expect(await ctx.adminUsers.byEmail("unreachable@example.com")).not.toBeNull();
  });

  it("signs the invitee in and reports that they still need a password", async () => {
    await invite("new@example.com");
    const res = await redeem(lastToken());

    expect(res.statusCode).toBe(200);
    expect(res.json().email).toBe("new@example.com");
    expect(res.json().hasPassword).toBe(false);
    const cookie = res.headers["set-cookie"];
    expect(String(cookie)).toContain("publoader_session=");
    expect(String(cookie)).toContain("HttpOnly");
  });

  // ---- single use, and what retires a link ----

  it("burns the link on first use", async () => {
    await invite("new@example.com");
    const token = lastToken();
    expect((await redeem(token)).statusCode).toBe(200);

    const second = await redeem(token);
    expect(second.statusCode).toBe(401);
    expect(second.json().error).toMatch(/already been used/);
  });

  it("retires the previous link when a new one is sent", async () => {
    await invite("new@example.com");
    const first = lastToken();

    const resent = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${(await ctx.adminUsers.byEmail("new@example.com"))!.id}/magic-link`,
      headers: root,
      payload: {},
    });
    expect(resent.statusCode).toBe(200);
    const second = lastToken();
    expect(second).not.toBe(first);

    // Otherwise every resend widens the window instead of moving it.
    const stale = await redeem(first);
    expect(stale.statusCode).toBe(401);
    expect(stale.json().error).toMatch(/replaced/);
    expect((await redeem(second)).statusCode).toBe(200);
  });

  it("retires outstanding links once the account has a password of its own", async () => {
    await invite("new@example.com");
    const token = lastToken();
    const signedIn = await redeem(token);
    const cookie = String(signedIn.headers["set-cookie"]).split(";")[0]!;

    // A second link, outstanding at the moment the password is set.
    const user = (await ctx.adminUsers.byEmail("new@example.com"))!;
    await ctx.magicLinks.send(user, "LOGIN");
    const outstanding = lastToken();

    const set = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${user.id}/password`,
      headers: { cookie, "x-requested-with": "publoader-dash" },
      payload: { password: "a-long-enough-password" },
    });
    expect(set.statusCode).toBe(200);

    const stale = await redeem(outstanding);
    expect(stale.statusCode).toBe(401);

    // And the password now works, which is the point of the whole flow.
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/admin/session",
      payload: { email: "new@example.com", password: "a-long-enough-password" },
    });
    expect(login.statusCode).toBe(200);
  });

  it("rejects a token that never existed", async () => {
    const res = await redeem("not-a-real-token");
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatch(/not valid/);
  });

  // ---- requesting a link from the login page ----

  it("answers identically for a known and an unknown address", async () => {
    await invite("known@example.com");
    mailer.sent.length = 0;

    const known = await request("known@example.com");
    const unknown = await request("nobody@example.com");

    // Anything else here is an account-enumeration oracle.
    expect(known.statusCode).toBe(202);
    expect(unknown.statusCode).toBe(202);
    expect(known.json()).toEqual(unknown.json());
    // But only one of them actually sent anything.
    expect(mailer.sent.map((m) => m.to)).toEqual(["known@example.com"]);
  });

  it("does not create an account for an unknown address while signups are closed", async () => {
    await request("stranger@example.com");
    expect(await ctx.adminUsers.byEmail("stranger@example.com")).toBeNull();
  });

  it("creates an unapproved account once signups are open, and sends no link", async () => {
    await ctx.settings.setSignupsEnabled(true);
    await request("stranger@example.com");

    const created = await ctx.adminUsers.byEmail("stranger@example.com");
    expect(created?.approved).toBe(false);
    expect(mailer.sent.at(-1)!.subject).toMatch(/awaiting approval/i);
    expect(mailer.sent.at(-1)!.text).not.toContain("#token=");
  });

  it("mails a link when an owner approves a pending signup", async () => {
    await ctx.settings.setSignupsEnabled(true);
    await request("stranger@example.com");
    const pending = (await ctx.adminUsers.byEmail("stranger@example.com"))!;
    mailer.sent.length = 0;

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${pending.id}/approve`,
      headers: root,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().emailed).toBe(true);
    expect(mailer.sent.at(-1)!.subject).toMatch(/ready/i);
    expect((await redeem(lastToken())).statusCode).toBe(200);
  });

  it("will not turn a link for an unapproved account into a session", async () => {
    await invite("new@example.com");
    const token = lastToken();
    // Approval withdrawn between the send and the click.
    await prisma.adminUser.update({
      where: { email: "new@example.com" },
      data: { approved: false },
    });

    const res = await redeem(token);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/awaiting approval/);
  });

  it("refuses to send a link to an account that is not approved yet", async () => {
    await ctx.settings.setSignupsEnabled(true);
    await request("stranger@example.com");
    const pending = (await ctx.adminUsers.byEmail("stranger@example.com"))!;

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${pending.id}/magic-link`,
      headers: root,
      payload: {},
    });
    expect(res.statusCode).toBe(409);
  });

  // ---- what the login page is told ----

  it("advertises the magic-link method only when a mailer is configured", async () => {
    const withMail = await app.inject({ method: "GET", url: "/api/v1/admin/session/methods" });
    expect(withMail.json().magicLink).toBe(true);

    const bare = buildServer(buildContext(prisma, config, log));
    await bare.ready();
    try {
      const res = await bare.inject({ method: "GET", url: "/api/v1/admin/session/methods" });
      expect(res.json().magicLink).toBe(false);
      // And the request endpoint refuses rather than pretending it worked.
      const req = await bare.inject({
        method: "POST",
        url: "/api/v1/admin/session/magic-link/request",
        payload: { email: "a@b.co" },
      });
      expect(req.statusCode).toBe(503);
    } finally {
      await bare.close();
    }
  });
});
