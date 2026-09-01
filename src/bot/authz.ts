/**
 * Discord-side gating. This is the bot's *own* allowlist, layered on top of
 * whatever the API token is scoped to; the token decides what the bot could
 * do, this decides who is allowed to ask it to.
 *
 * Two things make this module worth its own file: it is the security boundary
 * between "anyone in the guild" and the platform's control plane, and it is
 * pure. It takes a plain `{userId, roleIds, channelId, guildId}` shape and
 * returns a decision, no discord.js objects, no I/O, so every branch is
 * unit-testable (test/unit/botAuthz.test.ts).
 *
 * ## An empty config fails closed
 *
 * Anything that mutates is denied when its allowlist is unconfigured, and the
 * refusal says so. Failing open would mean a fresh deployment with an
 * incomplete config let every member of the guild trigger runs and pause the
 * platform. Read-only commands stay permissive, because their worst case is a
 * noisy channel rather than a changed platform.
 *
 * ## Where the lists come from
 *
 * Either the environment (`loadAuthzConfig`) or the control plane's own
 * settings, edited from the dashboard (`authzFromLists`). This module does not
 * care which; it is handed a resolved config. `src/bot/authzSource.ts` owns the
 * precedence between the two.
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
  /**
   * Guilds this bot answers in. Empty means "any guild", which is how a
   * deployment that never pinned one behaves; a non-empty set refuses every
   * other guild and all DMs.
   *
   * A set rather than a single id because one bot installed in two servers is
   * a real deployment — a staff server and a contributor server, say — and the
   * alternative was running a second bot process purely to widen this one
   * field.
   */
  guildIds: ReadonlySet<string>;
  adminUserIds: ReadonlySet<string>;
  adminRoleIds: ReadonlySet<string>;
  allowedChannelIds: ReadonlySet<string>;
}

/** The four allowlists as plain arrays, which is how they cross a wire. */
export interface AuthzLists {
  guildIds: string[];
  adminUserIds: string[];
  adminRoleIds: string[];
  allowedChannelIds: string[];
}

/** Everything about an invocation that the decision depends on. */
export interface Invoker {
  userId: string;
  roleIds: readonly string[];
  channelId: string;
  /**
   * The parent channel when `channelId` is a thread, else null.
   *
   * Discord reports a thread's *own* id as the interaction channel, so without
   * this an allowlisted `#ops` would refuse every command typed in a thread
   * under `#ops` — and each new thread would need allowlisting by hand.
   * Allowing the parent is what makes "this channel controls the platform"
   * mean what an operator thinks it means.
   */
  parentChannelId?: string | null;
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
 * ignores it. Digits-only is the real filter; a snowflake is always numeric,
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

/** The same filter for values that already arrived as an array (from the API). */
export function cleanIdList(raw: readonly unknown[] | undefined | null): Set<string> {
  const out = new Set<string>();
  for (const value of raw ?? []) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed && /^\d+$/.test(trimmed)) out.add(trimmed);
  }
  return out;
}

export function loadAuthzConfig(env: Record<string, string | undefined>): AuthzConfig {
  return {
    // Parsed as a list so `DISCORD_GUILD_ID=111,222` works; a single id is the
    // one-element case, and the non-numeric junk that used to read as "unset"
    // still does, because parseIdList drops it.
    guildIds: parseIdList(env["DISCORD_GUILD_ID"]),
    adminUserIds: parseIdList(env["DISCORD_ADMIN_USERS"]),
    adminRoleIds: parseIdList(env["DISCORD_ADMIN_ROLES"]),
    allowedChannelIds: parseIdList(env["DISCORD_ALLOWED_CHANNELS"]),
  };
}

/** Build a config from lists that came off the API, applying the same filter. */
export function authzFromLists(lists: Partial<AuthzLists> | null | undefined): AuthzConfig {
  return {
    guildIds: cleanIdList(lists?.guildIds),
    adminUserIds: cleanIdList(lists?.adminUserIds),
    adminRoleIds: cleanIdList(lists?.adminRoleIds),
    allowedChannelIds: cleanIdList(lists?.allowedChannelIds),
  };
}

/** The inverse, for handing a config to the API or the dashboard. */
export function authzToLists(config: AuthzConfig): AuthzLists {
  return {
    guildIds: [...config.guildIds],
    adminUserIds: [...config.adminUserIds],
    adminRoleIds: [...config.adminRoleIds],
    allowedChannelIds: [...config.allowedChannelIds],
  };
}

/** Is every list empty? Used to decide whether stored config exists at all. */
export function isAuthzEmpty(config: AuthzConfig): boolean {
  return (
    config.guildIds.size === 0 &&
    config.adminUserIds.size === 0 &&
    config.adminRoleIds.size === 0 &&
    config.allowedChannelIds.size === 0
  );
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

/** Does this invocation sit in an allowed channel, or in a thread under one? */
function channelAllowed(config: AuthzConfig, invoker: Invoker): boolean {
  if (config.allowedChannelIds.has(invoker.channelId)) return true;
  const parent = invoker.parentChannelId;
  return parent != null && config.allowedChannelIds.has(parent);
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

  if (config.guildIds.size > 0 && (invoker.guildId == null || !config.guildIds.has(invoker.guildId))) {
    return {
      allowed: false,
      reason:
        invoker.guildId == null
          ? "This bot only takes commands inside its configured guild, not in DMs."
          : "This bot is bound to a different guild and will not act on commands from this one.",
    };
  }

  if (config.allowedChannelIds.size > 0) {
    if (!channelAllowed(config, invoker)) {
      return { allowed: false, reason: "This channel is not on the bot's allowed-channel list." };
    }
  } else if (mutating) {
    // Fail closed: see the module comment. A mutating command with no channel
    // allowlist configured is a misconfiguration, not a permission.
    return {
      allowed: false,
      reason:
        "Refusing a state-changing command because no allowed channels are configured. " +
        "Set them on the dashboard's Permissions page, or via `DISCORD_ALLOWED_CHANNELS`.",
    };
  }

  if (mutating) {
    if (!hasAdminAllowlist(config)) {
      return {
        allowed: false,
        reason:
          "Refusing a state-changing command because no admins are configured. " +
          "Set them on the dashboard's Permissions page, or via `DISCORD_ADMIN_USERS` / `DISCORD_ADMIN_ROLES`.",
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
  const guilds =
    config.guildIds.size === 0
      ? "guild: any (no guild pinned)"
      : config.guildIds.size === 1
        ? `guild ${[...config.guildIds][0]}`
        : `${config.guildIds.size} guilds`;
  const parts = [
    guilds,
    config.allowedChannelIds.size > 0
      ? `${config.allowedChannelIds.size} allowed channel(s)`
      : "channels: any for reads, NONE for writes (no allowed channels configured)",
    hasAdminAllowlist(config)
      ? `${config.adminUserIds.size} admin user(s), ${config.adminRoleIds.size} admin role(s)`
      : "admins: NONE configured; all writes denied",
  ];
  return parts.join("; ");
}
