import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { AdminRole, AdminSession, AdminUser, PrismaClient } from "@prisma/client";

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

/**
 * Dashboard operator accounts and their sessions.
 *
 * Every piece of auth state is a Postgres row, which is what makes an
 * individual session revocable and an account approvable. Nothing here returns
 * a stored secret: passwords are scrypt-hashed and session secrets are
 * sha256-hashed, both compared in constant time.
 */

/** Deliberately expensive; ~100ms per verification on a modern core. */
const SCRYPT = { N: 16_384, r: 8, p: 1 } as const;
const SCRYPT_KEYLEN = 64;

export const MIN_PASSWORD_LENGTH = 12;

/** Encoded as `salt:hash`, both hex, matching the schema's documented shape. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN, SCRYPT);
  return `${salt.toString("hex")}:${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  let expected: Buffer;
  try {
    expected = Buffer.from(hashHex, "hex");
  } catch {
    return false;
  }
  if (expected.length !== SCRYPT_KEYLEN) return false;
  const derived = await scrypt(password, Buffer.from(saltHex, "hex"), SCRYPT_KEYLEN, SCRYPT);
  return timingSafeEqual(derived, expected);
}

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/** What the auth layer needs to make a decision, resolved in one query. */
export interface ResolvedSession {
  sessionId: string;
  userId: string;
  actor: string;
  role: AdminRole;
  email: string;
  expiresAt: Date;
  /**
   * The account's own permission tuning, carried on the session so the scope
   * set is recomputed per request. That is what makes a revoked permission
   * take effect on a session that is already open, rather than at next login.
   */
  extraScopes: string[];
  deniedScopes: string[];
}

export type AdminUserPublic = Omit<AdminUser, "passwordHash"> & { hasPassword: boolean };

/** Never leak the hash to a client, but do say whether one is set. */
export function toPublicUser(user: AdminUser): AdminUserPublic {
  const { passwordHash, ...rest } = user;
  return { ...rest, hasPassword: passwordHash !== null };
}

export class AdminUserStore {
  constructor(private readonly prisma: PrismaClient) {}

  // ---- accounts ----

  /**
   * Idempotently ensure the configured owner exists. Runs on every core-api
   * start so a fresh database is never locked out, and so an owner that was
   * demoted or unapproved by accident is restored to a usable state.
   */
  async ensureOwner(email: string): Promise<AdminUser> {
    const normalised = email.trim().toLowerCase();
    const existing = await this.prisma.adminUser.findUnique({ where: { email: normalised } });
    if (existing) {
      if (existing.role === "OWNER" && existing.approved) return existing;
      return this.prisma.adminUser.update({
        where: { id: existing.id },
        data: { role: "OWNER", approved: true },
      });
    }
    return this.prisma.adminUser.create({
      data: { email: normalised, role: "OWNER", approved: true },
    });
  }

  list(): Promise<AdminUser[]> {
    return this.prisma.adminUser.findMany({ orderBy: { createdAt: "asc" } });
  }

  byId(id: string): Promise<AdminUser | null> {
    return this.prisma.adminUser.findUnique({ where: { id } });
  }

  byEmail(email: string): Promise<AdminUser | null> {
    return this.prisma.adminUser.findUnique({ where: { email: email.trim().toLowerCase() } });
  }

  /**
   * Invite: an approved account with no credentials yet. The invitee gets in
   * with the emailed sign-in link, by linking Discord, or by an owner setting
   * a password for them.
   */
  invite(email: string, role: AdminRole): Promise<AdminUser> {
    return this.prisma.adminUser.create({
      data: { email: email.trim().toLowerCase(), role, approved: true },
    });
  }

  /**
   * Self-signup by email address. Unapproved and non-privileged by
   * construction, exactly like the Discord path: mailbox control is evidence
   * of an address, never of authorisation.
   */
  createPendingSignup(email: string): Promise<AdminUser> {
    return this.prisma.adminUser.create({
      data: { email: email.trim().toLowerCase(), role: "ADMIN", approved: false },
    });
  }

  async setPassword(id: string, password: string): Promise<void> {
    await this.prisma.adminUser.update({
      where: { id },
      data: { passwordHash: await hashPassword(password) },
    });
  }

  async approve(id: string): Promise<AdminUser | null> {
    const updated = await this.prisma.adminUser.updateMany({
      where: { id, approved: false },
      data: { approved: true },
    });
    return updated.count === 1 ? this.byId(id) : null;
  }

  private async ownerCount(excludingId?: string): Promise<number> {
    return this.prisma.adminUser.count({
      where: { role: "OWNER", ...(excludingId ? { id: { not: excludingId } } : {}) },
    });
  }

  /**
   * Demotion and deletion both have to leave at least one OWNER standing —
   * otherwise the only way back in is the break-glass admin token.
   */
  async setRole(id: string, role: AdminRole): Promise<"ok" | "unknown" | "last-owner"> {
    const user = await this.byId(id);
    if (!user) return "unknown";
    if (user.role === "OWNER" && role !== "OWNER" && (await this.ownerCount(id)) === 0) {
      return "last-owner";
    }
    // Promotion to OWNER drops the account's tuning rather than parking it.
    // An owner ignores grants and denials, so keeping them would mean a later
    // demotion silently reinstates restrictions nobody remembers setting.
    const clearTuning = role === "OWNER" && user.role !== "OWNER";
    await this.prisma.adminUser.update({
      where: { id },
      data: { role, ...(clearTuning ? { extraScopes: [], deniedScopes: [] } : {}) },
    });
    return "ok";
  }

  /**
   * Tune one account on top of its role: scopes it holds beyond the role, and
   * scopes it is refused despite the role. Both lists are replaced wholesale —
   * an editor that reads the current state and writes the intended state back
   * cannot half-apply, which a per-scope add/remove API can.
   */
  async setScopes(
    id: string,
    tuning: { extraScopes: string[]; deniedScopes: string[] },
  ): Promise<AdminUser> {
    return this.prisma.adminUser.update({
      where: { id },
      data: {
        extraScopes: [...new Set(tuning.extraScopes)],
        deniedScopes: [...new Set(tuning.deniedScopes)],
      },
    });
  }

  async remove(id: string): Promise<"ok" | "unknown" | "last-owner"> {
    const user = await this.byId(id);
    if (!user) return "unknown";
    if (user.role === "OWNER" && (await this.ownerCount(id)) === 0) return "last-owner";
    // Sessions cascade with the user row, so deletion is also a logout.
    await this.prisma.adminUser.delete({ where: { id } });
    return "ok";
  }

  async linkDiscord(id: string, discordId: string, discordUsername: string): Promise<AdminUser> {
    return this.prisma.adminUser.update({
      where: { id },
      data: { discordId, discordUsername },
    });
  }

  /**
   * Detach Discord from an account. The reverse of `linkDiscord`, and the
   * thing that makes linking safe to offer: a credential you cannot remove is
   * one people are right to hesitate before adding.
   */
  async unlinkDiscord(id: string): Promise<AdminUser> {
    return this.prisma.adminUser.update({
      where: { id },
      data: { discordId: null, discordUsername: null },
    });
  }

  byDiscordId(discordId: string): Promise<AdminUser | null> {
    return this.prisma.adminUser.findUnique({ where: { discordId } });
  }

  createFromDiscord(opts: {
    email: string;
    discordId: string;
    discordUsername: string;
  }): Promise<AdminUser> {
    // Self-signup lands unapproved and non-privileged by construction.
    return this.prisma.adminUser.create({
      data: {
        email: opts.email.trim().toLowerCase(),
        discordId: opts.discordId,
        discordUsername: opts.discordUsername,
        role: "ADMIN",
        approved: false,
      },
    });
  }

  // ---- sessions ----

  /**
   * Mint a session. The cookie is `${id}.${secret}`: the id is a lookup key
   * and the secret is what is actually verified, so a leaked session *id*
   * (in a log, in an admin list view) is not a credential.
   */
  async createSession(user: AdminUser, actor: string, ttlSeconds: number): Promise<string> {
    const secret = randomBytes(32).toString("base64url");
    const session = await this.prisma.adminSession.create({
      data: {
        userId: user.id,
        tokenHash: sha256(secret),
        actor,
        expiresAt: new Date(Date.now() + ttlSeconds * 1000),
      },
    });
    await this.prisma.adminUser.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });
    return `${session.id}.${secret}`;
  }

  /** Returns the session only if it is live, unrevoked, and the user approved. */
  async resolveSession(cookieValue: string): Promise<ResolvedSession | null> {
    const dot = cookieValue.indexOf(".");
    if (dot <= 0 || dot === cookieValue.length - 1) return null;
    const id = cookieValue.slice(0, dot);
    const secret = cookieValue.slice(dot + 1);
    // A malformed id would make Prisma throw on a uuid column; keep it cheap.
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;

    const session = await this.prisma.adminSession.findUnique({
      where: { id },
      include: { user: true },
    });
    if (!session || session.revoked) return null;
    if (session.expiresAt.getTime() <= Date.now()) return null;
    if (!session.user.approved) return null;

    const given = Buffer.from(sha256(secret), "utf8");
    const expected = Buffer.from(session.tokenHash, "utf8");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

    return {
      sessionId: session.id,
      userId: session.userId,
      actor: session.actor,
      role: session.user.role,
      email: session.user.email,
      expiresAt: session.expiresAt,
      extraScopes: session.user.extraScopes,
      deniedScopes: session.user.deniedScopes,
    };
  }

  async revokeSession(id: string): Promise<boolean> {
    const res = await this.prisma.adminSession.updateMany({
      where: { id, revoked: false },
      data: { revoked: true },
    });
    return res.count === 1;
  }

  /** Live sessions only — revoked and expired rows are noise in the UI. */
  listSessions(): Promise<(AdminSession & { user: AdminUser })[]> {
    return this.prisma.adminSession.findMany({
      where: { revoked: false, expiresAt: { gt: new Date() } },
      include: { user: true },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
  }
}
