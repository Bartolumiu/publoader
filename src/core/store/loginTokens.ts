import { createHash, randomBytes } from "node:crypto";
import type { AdminUser, LoginToken, LoginTokenPurpose, PrismaClient } from "@prisma/client";

/**
 * Email sign-in links.
 *
 * A link is a bearer credential that arrives over a channel we do not control,
 * so the rules are tighter than a session's:
 *
 *  - only sha256 of the secret is stored, so the table is not a credential store;
 *  - redemption is a conditional UPDATE, which is what makes "single use" true
 *    under two concurrent clicks (mail clients prefetch links) rather than only
 *    true in the happy path;
 *  - redeeming one link retires every other outstanding link for that account,
 *    so an older link sitting in an inbox stops being a way in;
 *  - setting a password does the same, because from that moment the account has
 *    a credential the holder chose.
 */

const SECRET_BYTES = 32;

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/** Why a redemption failed. The route maps these onto operator-facing text. */
export type ConsumeFailure = "unknown" | "used" | "expired" | "revoked" | "unapproved";

export type ConsumeResult =
  | { ok: true; token: LoginToken; user: AdminUser }
  | { ok: false; reason: ConsumeFailure };

export interface IssuedToken {
  /** The secret half — goes in the URL and nowhere else, ever. */
  secret: string;
  id: string;
  expiresAt: Date;
}

export class LoginTokenStore {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Mint a link for `user`. Any link already outstanding for that account is
   * retired first: a "resend" must invalidate the previous mail, otherwise
   * every send widens the window instead of moving it.
   */
  async issue(opts: {
    user: AdminUser;
    purpose: LoginTokenPurpose;
    ttlSeconds: number;
    requestedIp?: string | null;
  }): Promise<IssuedToken> {
    const secret = randomBytes(SECRET_BYTES).toString("base64url");
    await this.revokeOutstanding(opts.user.id);
    const row = await this.prisma.loginToken.create({
      data: {
        userId: opts.user.id,
        tokenHash: sha256(secret),
        purpose: opts.purpose,
        email: opts.user.email,
        expiresAt: new Date(Date.now() + opts.ttlSeconds * 1000),
        requestedIp: opts.requestedIp?.slice(0, 64) ?? null,
      },
    });
    return { secret, id: row.id, expiresAt: row.expiresAt };
  }

  /**
   * Redeem a link. The UPDATE is the whole concurrency story: at most one
   * caller can move `consumed_at` from NULL, so at most one caller is handed
   * the account.
   *
   * The distinction between "unknown" and "used"/"expired" is deliberately
   * kept — this endpoint is reached by clicking a link the holder already has,
   * so precise feedback helps a locked-out operator and tells an attacker
   * nothing they could not learn by trying.
   */
  async consume(secret: string): Promise<ConsumeResult> {
    if (!secret || secret.length > 512) return { ok: false, reason: "unknown" };
    const tokenHash = sha256(secret);

    const claimed = await this.prisma.loginToken.updateMany({
      where: { tokenHash, consumedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() },
    });

    const row = await this.prisma.loginToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
    if (!row) return { ok: false, reason: "unknown" };

    if (claimed.count !== 1) {
      if (row.revokedAt) return { ok: false, reason: "revoked" };
      if (row.consumedAt) return { ok: false, reason: "used" };
      return { ok: false, reason: "expired" };
    }

    // Approval can be withdrawn between sending and clicking; the link must not
    // outrank it. The token stays consumed — a rejected click still burns it.
    if (!row.user.approved) return { ok: false, reason: "unapproved" };

    // Every other link for this account is now stale mail.
    await this.revokeOutstanding(row.userId, row.id);

    const { user, ...token } = row;
    return { ok: true, token, user };
  }

  /**
   * Retire outstanding links for an account. Called on issue, on redemption,
   * and whenever the account gains a password of its own.
   */
  async revokeOutstanding(userId: string, exceptId?: string): Promise<number> {
    const res = await this.prisma.loginToken.updateMany({
      where: {
        userId,
        consumedAt: null,
        revokedAt: null,
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      data: { revokedAt: new Date() },
    });
    return res.count;
  }

  /** Most recent link for an account, for the "sent 2 minutes ago" read-out. */
  latestFor(userId: string): Promise<LoginToken | null> {
    return this.prisma.loginToken.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
  }

  /**
   * Drop rows that can no longer authenticate anything. Consumed and revoked
   * rows are kept for a window because they are the evidence behind "that link
   * was already used", which is the message a confused operator needs.
   */
  async purge(retainConsumedForDays = 30): Promise<number> {
    const cutoff = new Date(Date.now() - retainConsumedForDays * 86_400_000);
    const res = await this.prisma.loginToken.deleteMany({
      where: {
        OR: [
          { expiresAt: { lt: cutoff }, consumedAt: null },
          { consumedAt: { lt: cutoff } },
          { revokedAt: { lt: cutoff } },
        ],
      },
    });
    return res.count;
  }
}
