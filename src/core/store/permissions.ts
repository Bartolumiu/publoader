import type { PrismaClient } from "@prisma/client";
import {
  DEFAULT_ROLE_SCOPES,
  TUNABLE_ROLES,
  effectiveScopes,
  type Role,
} from "../api/scopes.js";

/**
 * Deployment-specific permission tuning.
 *
 * Two knobs, deliberately layered. The role baseline answers "what does an
 * ADMIN here get?", and the per-account grants and denials answer "what about
 * this one person?" — which is the question that otherwise gets answered by
 * promoting somebody a notch too far, because inventing a role for one person
 * is worse.
 *
 * The role table is an OVERRIDE list. No row means the shipped default, so a
 * deployment that never touches it keeps tracking the defaults as they change
 * across releases, and resetting a role is a delete rather than a re-typing of
 * whatever the default happened to be.
 */

/** What a role's baseline is, and whether this deployment chose it. */
export interface RoleBaseline {
  role: Role;
  scopes: string[];
  /** The shipped default, so an editor can show what "reset" would restore. */
  defaults: string[];
  custom: boolean;
  tunable: boolean;
  updatedBy?: string | null;
  updatedAt?: Date | null;
}

/**
 * How long a cached override may be stale.
 *
 * Overrides are read on every authenticated request and written about once a
 * quarter, so the read has to be free; but more than one core-api may be
 * running, and cache invalidation only reaches the process that did the write.
 * A few seconds is the compromise: fast enough that an operator watching the
 * dashboard sees their own change land, short enough that a revoked permission
 * is never meaningfully outstanding.
 */
const CACHE_TTL_MS = 5_000;

export class PermissionStore {
  private cache: Map<Role, string[]> | null = null;
  private cachedAt = 0;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly ttlMs: number = CACHE_TTL_MS,
  ) {}

  private now(): number {
    return Date.now();
  }

  /** Drop the memo so the next read hits Postgres. */
  invalidate(): void {
    this.cache = null;
  }

  private async overrides(): Promise<Map<Role, string[]>> {
    if (this.cache && this.now() - this.cachedAt < this.ttlMs) return this.cache;
    const rows = await this.prisma.rolePermission.findMany();
    const map = new Map<Role, string[]>();
    for (const row of rows) {
      // OWNER can never be tuned, so a row for it — from an older release, or a
      // hand-edited database — is ignored rather than obeyed.
      if (row.role === "OWNER") continue;
      map.set(row.role as Role, row.scopes);
    }
    this.cache = map;
    this.cachedAt = this.now();
    return map;
  }

  /** The baseline scope list for a role: this deployment's, or the default. */
  async roleScopes(role: Role): Promise<string[]> {
    if (role === "OWNER") return [...DEFAULT_ROLE_SCOPES.OWNER];
    const override = (await this.overrides()).get(role);
    return override ? [...override] : [...DEFAULT_ROLE_SCOPES[role]];
  }

  /** Every role's baseline, for the permission editor. */
  async baselines(): Promise<RoleBaseline[]> {
    const rows = await this.prisma.rolePermission.findMany();
    const byRole = new Map(rows.map((r) => [r.role as Role, r]));
    const roles: Role[] = ["OWNER", "ADMIN", "CONTRIBUTOR"];
    return roles.map((role) => {
      const tunable = (TUNABLE_ROLES as readonly string[]).includes(role);
      const row = tunable ? byRole.get(role) : undefined;
      return {
        role,
        scopes: row ? [...row.scopes] : [...DEFAULT_ROLE_SCOPES[role]],
        defaults: [...DEFAULT_ROLE_SCOPES[role]],
        custom: Boolean(row),
        tunable,
        updatedBy: row?.updatedBy ?? null,
        updatedAt: row?.updatedAt ?? null,
      };
    });
  }

  async setRoleScopes(
    role: "ADMIN" | "CONTRIBUTOR",
    scopes: readonly string[],
    updatedBy: string,
  ): Promise<string[]> {
    const stored = [...new Set(scopes)];
    await this.prisma.rolePermission.upsert({
      where: { role },
      create: { role, scopes: stored, updatedBy },
      update: { scopes: stored, updatedBy },
    });
    this.invalidate();
    return stored;
  }

  /** Back to the shipped default. Returns false when it already was. */
  async resetRole(role: "ADMIN" | "CONTRIBUTOR"): Promise<boolean> {
    const deleted = await this.prisma.rolePermission.deleteMany({ where: { role } });
    this.invalidate();
    return deleted.count > 0;
  }

  /**
   * What one account actually holds: role baseline, widened by its grants,
   * narrowed by its denials.
   *
   * An OWNER is returned unmodified. The role that administers permissions has
   * to be the one role permissions cannot be used against, or a mis-click
   * locks a deployment out of its own control plane.
   */
  async effectiveForUser(user: {
    role: Role;
    extraScopes?: readonly string[];
    deniedScopes?: readonly string[];
  }): Promise<string[]> {
    const baseline = await this.roleScopes(user.role);
    if (user.role === "OWNER") return baseline;
    return effectiveScopes(baseline, user.extraScopes ?? [], user.deniedScopes ?? []);
  }
}
