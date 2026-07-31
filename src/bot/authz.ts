/**
 * Discord-side gating. This is the bot's *own* allowlist, layered on top of
 * whatever the API token is scoped to — the token decides what the bot could
 * do, this decides who is allowed to ask it to.
 *
 * Two things make this module worth its own file: it is the security boundary
 * between "anyone in the guild" and the platform's control plane, and it is
 * pure. It takes a plain `{userId, roleIds, channelId, guildId}` shape and
 * returns a decision — no discord.js objects, no I/O — so every branch is
 * unit-testable (test/unit/botAuthz.test.ts).
 *
 * ## Deliberate difference from the legacy bot
 *
 * The Python bot failed OPEN: `_is_admin` returned True when neither
 * DISCORD_ADMIN_USERS nor DISCORD_ADMIN_ROLES was configured, and
 * `_channel_allowed` returned True when DISCORD_ALLOWED_CHANNELS was empty. A
 * fresh deployment with an incomplete .env therefore let every member of the
 * guild trigger runs and pause the platform.
 *
 * This version fails CLOSED for anything that mutates: an unconfigured
 * allowlist denies, and says so. Read-only commands stay permissive because
 * their worst case is a noisy channel, not a changed platform.
 */

/** How much damage a command can do, which is what decides how it is gated. */
export type Sensitivity =
  /** Reads state. Allowed to non-admins; channel allowlist applies only if set. */
  | "read"
  /** Changes platform state. Admin + allowed channel, both required. */
  | "mutate"
  /**
   * Irreversible from the API, or hands out a credential. Same gate as
   * `mutate` plus an explicit confirmation argument, enforced by the handler.
   */
  | "destructive";

export interface AuthzConfig {
  /** When set, commands from any other guild — and all DMs — are refused. */
  guildId: string | null;
  adminUserIds: ReadonlySet<string>;
  adminRoleIds: ReadonlySet<string>;
  allowedChannelIds: ReadonlySet<string>;
}

/** Everything about an invocation that the decision depends on. */
export interface Invoker {
  userId: string;
  roleIds: readonly string[];
  channelId: string;
  /** null in a DM. */
  guildId?: string | null;
}

export type Decision = { allowed: true } | { allowed: false; reason: string };

const ALLOW: Decision = { allowed: true };

/**
 * Parse a comma- or space-separated list of Discord snowflakes.
 *
 * Non-numeric junk is dropped rather than rejected: the legacy config was
 * hand-edited and often carried `<@123>` mention syntax or trailing commas, and
 * a bot that refuses to boot over a stray character is worse than one that
 * ignores it. Digits-only is the real filter — a snowflake is always numeric,
 * so a mis-pasted username can never widen the allowlist.
 */
export function parseIdList(raw: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const token of (raw ?? "").split(/[\s,]+/)) {
    const trimmed = token.trim();
    if (trimmed && /^\d+$/.test(trimmed)) out.add(trimmed);
  }
  return out;
}

export function loadAuthzConfig(env: Record<string, string | undefined>): AuthzConfig {
  const guild = (env["DISCORD_GUILD_ID"] ?? "").trim();
  return {
    guildId: /^\d+$/.test(guild) ? guild : null,
    adminUserIds: parseIdList(env["DISCORD_ADMIN_USERS"]),
    adminRoleIds: parseIdList(env["DISCORD_ADMIN_ROLES"]),
    allowedChannelIds: parseIdList(env["DISCORD_ALLOWED_CHANNELS"]),
  };
}

/** Is this user an admin by explicit id or by holding an admin role? */
export function isAdmin(config: AuthzConfig, invoker: Invoker): boolean {
  if (config.adminUserIds.has(invoker.userId)) return true;
  return invoker.roleIds.some((id) => config.adminRoleIds.has(id));
}

/** Is at least one admin principal configured at all? */
export function hasAdminAllowlist(config: AuthzConfig): boolean {
  return config.adminUserIds.size > 0 || config.adminRoleIds.size > 0;
}

/**
 * The whole decision, in one place.
 *
 * Order matters: guild first (wrong server is not a question of who you are),
 * then channel, then privilege. That way the reason an operator sees names the
 * outermost problem rather than a downstream symptom of it.
 */
export function authorize(config: AuthzConfig, invoker: Invoker, sensitivity: Sensitivity): Decision {
  const mutating = sensitivity !== "read";

  if (config.guildId !== null && invoker.guildId !== config.guildId) {
    return {
      allowed: false,
      reason:
        invoker.guildId == null
          ? "This bot only takes commands inside its configured guild, not in DMs."
          : "This bot is bound to a different guild and will not act on commands from this one.",
    };
  }

  if (config.allowedChannelIds.size > 0) {
    if (!config.allowedChannelIds.has(invoker.channelId)) {
      return { allowed: false, reason: "This channel is not on the bot's allowed-channel list." };
    }
  } else if (mutating) {
    // Fail closed: see the module comment. A mutating command with no channel
    // allowlist configured is a misconfiguration, not a permission.
    return {
      allowed: false,
      reason:
        "Refusing a state-changing command because `DISCORD_ALLOWED_CHANNELS` is not configured. " +
        "Set it to the channel(s) that may control the platform, then redeploy the bot.",
    };
  }

  if (mutating) {
    if (!hasAdminAllowlist(config)) {
      return {
        allowed: false,
        reason:
          "Refusing a state-changing command because no admins are configured. " +
          "Set `DISCORD_ADMIN_USERS` and/or `DISCORD_ADMIN_ROLES`, then redeploy the bot.",
      };
    }
    if (!isAdmin(config, invoker)) {
      return {
        allowed: false,
        reason:
          sensitivity === "destructive"
            ? "This command is destructive and restricted to platform admins."
            : "This command changes platform state and is restricted to platform admins.",
      };
    }
  }

  return ALLOW;
}

/**
 * A one-line summary of the gating in force, for the startup log and `/whoami`.
 * Written so a misconfiguration is visible without reading the environment.
 */
export function describeAuthz(config: AuthzConfig): string {
  const parts = [
    config.guildId ? `guild ${config.guildId}` : "guild: any (DISCORD_GUILD_ID unset)",
    config.allowedChannelIds.size > 0
      ? `${config.allowedChannelIds.size} allowed channel(s)`
      : "channels: any for reads, NONE for writes (DISCORD_ALLOWED_CHANNELS unset)",
    hasAdminAllowlist(config)
      ? `${config.adminUserIds.size} admin user(s), ${config.adminRoleIds.size} admin role(s)`
      : "admins: NONE configured — all writes denied",
  ];
  return parts.join("; ");
}
