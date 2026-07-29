import { createHash, randomBytes } from "node:crypto";
import type { ApiToken, PrismaClient } from "@prisma/client";
import { parseScopes } from "../api/scopes.js";

/**
 * Scoped per-client API tokens (`pa_…`).
 *
 * One token per machine client, carrying only the scopes that client needs, so
 * a leaked credential is confined to its area. Only sha256 hashes are stored:
 * the plaintext is shown exactly once at mint time and is unrecoverable
 * afterwards, which is also why rotation is "mint new, revoke old" rather than
 * "reveal existing".
 */

export function hashApiToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export class InvalidScopesError extends Error {
  constructor(readonly invalid: string[]) {
    super(`unknown scopes: ${invalid.join(", ")}`);
    this.name = "InvalidScopesError";
  }
}

/** Throttle last-used writes: one row update per token per minute is plenty. */
const LAST_USED_THROTTLE_MS = 60_000;

export class ApiTokenStore {
  private readonly lastUsedWrites = new Map<string, number>();

  constructor(private readonly prisma: PrismaClient) {}

  async mint(opts: {
    name: string;
    scopes: readonly string[];
    createdBy: string;
    ttlDays?: number;
  }): Promise<{ token: string; row: ApiToken }> {
    const { scopes, invalid } = parseScopes(opts.scopes);
    if (invalid.length > 0) throw new InvalidScopesError(invalid);
    if (scopes.length === 0) throw new InvalidScopesError(["<empty scope list>"]);

    const token = `pa_${randomBytes(32).toString("base64url")}`;
    const row = await this.prisma.apiToken.create({
      data: {
        name: opts.name.slice(0, 128),
        tokenHash: hashApiToken(token),
        scopes,
        createdBy: opts.createdBy.slice(0, 256),
        expiresAt:
          opts.ttlDays === undefined
            ? null
            : new Date(Date.now() + opts.ttlDays * 86_400_000),
      },
    });
    return { token, row };
  }

  /**
   * Resolve a presented token. Returns null for unknown, revoked, or expired
   * tokens — the caller cannot distinguish which, on purpose.
   */
  async authenticate(token: string): Promise<ApiToken | null> {
    const row = await this.prisma.apiToken.findUnique({
      where: { tokenHash: hashApiToken(token) },
    });
    if (!row || row.revoked) return null;
    if (row.expiresAt && row.expiresAt <= new Date()) return null;
    return row;
  }

  /**
   * Record that a token was used. Fire-and-forget and throttled: this is
   * operator-facing telemetry ("is this credential still in use before I revoke
   * it?"), never an authorization input, so losing a write is harmless and
   * must not slow the request path.
   */
  touch(tokenId: string): void {
    const now = Date.now();
    const previous = this.lastUsedWrites.get(tokenId) ?? 0;
    if (now - previous < LAST_USED_THROTTLE_MS) return;
    this.lastUsedWrites.set(tokenId, now);
    void this.prisma.apiToken
      .update({ where: { id: tokenId }, data: { lastUsedAt: new Date(now) } })
      .catch(() => {
        // A failed telemetry write must never surface to the caller.
      });
  }

  /** Metadata only — there is no path that returns a token's secret. */
  async list(): Promise<Omit<ApiToken, "tokenHash">[]> {
    const rows = await this.prisma.apiToken.findMany({ orderBy: { createdAt: "desc" } });
    return rows.map(({ tokenHash: _tokenHash, ...rest }) => rest);
  }

  async revoke(id: string): Promise<boolean> {
    const res = await this.prisma.apiToken.updateMany({
      where: { id, revoked: false },
      data: { revoked: true },
    });
    return res.count === 1;
  }
}
