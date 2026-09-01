import type { PrismaClient } from "@prisma/client";

/**
 * The Discord bot's allowlists, stored as platform settings so they can be
 * edited from the dashboard, the API, the CLI and the bot itself rather than
 * only by editing `.env` and redeploying.
 *
 * ## Why this is a store and not four `SettingsStore` calls
 *
 * Because every entry carries a label. A raw allowlist is four columns of
 * nineteen-digit snowflakes, which no operator can audit: "is 800000000000000002
 * still the right channel?" has no answer without leaving the page. Storing
 * `{id, label}` means the dashboard can render `#ops` and the audit log can say
 * which channel was removed, while the bot keeps consuming bare ids and never
 * trusts the label for anything.
 *
 * Labels are cosmetic by construction. Nothing in `src/bot/authz.ts` reads them,
 * so a stale or hostile label can mislead a reader but cannot widen a gate.
 */

/** One allowlisted snowflake, plus what a human calls it. */
export interface AuthzEntry {
  id: string;
  /** Free text: `#ops`, `@staff`, `Staff server`. Never used for matching. */
  label: string;
}

export const AUTHZ_LISTS = ["guilds", "channels", "adminUsers", "adminRoles"] as const;
export type AuthzListName = (typeof AUTHZ_LISTS)[number];

export type AuthzEntries = Record<AuthzListName, AuthzEntry[]>;

/** Settings keys. Namespaced so a future second bot can get its own prefix. */
const KEY: Record<AuthzListName, string> = {
  guilds: "discord.authz.guilds",
  channels: "discord.authz.channels",
  adminUsers: "discord.authz.adminUsers",
  adminRoles: "discord.authz.adminRoles",
};

/** A label long enough to be useful and short enough not to be an essay. */
const MAX_LABEL = 80;
/** Nobody has 200 admin roles; a cap keeps one bad PUT from bloating a row. */
const MAX_ENTRIES = 200;

const emptyEntries = (): AuthzEntries => ({
  guilds: [],
  channels: [],
  adminUsers: [],
  adminRoles: [],
});

/**
 * Normalise whatever arrived into storable entries.
 *
 * Accepts both `["123"]` and `[{id: "123", label: "#ops"}]` because the CLI and
 * the bot naturally produce the former and the dashboard the latter, and making
 * every caller construct objects would be ceremony. Non-numeric ids are dropped
 * with the same reasoning as `parseIdList`: a snowflake is always numeric, so a
 * mis-pasted username can never enter an allowlist.
 */
export function normaliseEntries(raw: unknown): AuthzEntry[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: AuthzEntry[] = [];
  for (const item of raw) {
    let id: unknown;
    let label: unknown = "";
    if (typeof item === "string") {
      id = item;
    } else if (item && typeof item === "object") {
      id = (item as { id?: unknown }).id;
      label = (item as { label?: unknown }).label ?? "";
    }
    if (typeof id !== "string") continue;
    const trimmed = id.trim();
    if (!/^\d+$/.test(trimmed) || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push({
      id: trimmed,
      label: (typeof label === "string" ? label : "").trim().slice(0, MAX_LABEL),
    });
    if (out.length >= MAX_ENTRIES) break;
  }
  return out;
}

/** Ids that were rejected, so a caller can be told rather than left guessing. */
export function rejectedIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const bad: string[] = [];
  for (const item of raw) {
    const id =
      typeof item === "string" ? item : item && typeof item === "object" ? (item as { id?: unknown }).id : undefined;
    if (typeof id !== "string") continue;
    const trimmed = id.trim();
    if (trimmed && !/^\d+$/.test(trimmed)) bad.push(trimmed.slice(0, 64));
  }
  return [...new Set(bad)];
}

function parseStored(raw: string | null): AuthzEntry[] {
  if (!raw) return [];
  try {
    return normaliseEntries(JSON.parse(raw));
  } catch {
    // A hand-edited row that is no longer JSON must not take the bot down; an
    // unreadable list reads as an empty one, which fails closed for writes.
    return [];
  }
}

export class BotAuthzStore {
  constructor(private readonly prisma: PrismaClient) {}

  /** Every list, with labels. Absent rows read as empty lists. */
  async get(): Promise<AuthzEntries> {
    const rows = await this.prisma.setting.findMany({
      where: { key: { in: Object.values(KEY) } },
    });
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    const out = emptyEntries();
    for (const name of AUTHZ_LISTS) out[name] = parseStored(byKey.get(KEY[name]) ?? null);
    return out;
  }

  /** Has an operator ever configured any of this? Decides env fallback. */
  async isConfigured(): Promise<boolean> {
    const count = await this.prisma.setting.count({
      where: { key: { in: Object.values(KEY) } },
    });
    return count > 0;
  }

  /**
   * Replace one list wholesale.
   *
   * Whole-list replacement rather than add/remove deltas because the dashboard
   * edits a textarea and the read-modify-write races that deltas avoid are not
   * a real risk here: two operators editing the same allowlist in the same
   * second is not a scenario worth a transaction for, and the audit log records
   * both the before and the after either way.
   */
  async setList(name: AuthzListName, entries: AuthzEntry[]): Promise<void> {
    const value = JSON.stringify(entries);
    await this.prisma.setting.upsert({
      where: { key: KEY[name] },
      create: { key: KEY[name], value },
      update: { value },
    });
  }

  /** Replace every provided list; lists omitted from `patch` are untouched. */
  async setLists(patch: Partial<Record<AuthzListName, AuthzEntry[]>>): Promise<AuthzEntries> {
    for (const name of AUTHZ_LISTS) {
      const entries = patch[name];
      if (entries) await this.setList(name, entries);
    }
    return this.get();
  }

  /**
   * Forget every stored list, which hands control back to the environment.
   *
   * This is the way out of a lockout that does not involve psql: an OWNER can
   * clear the stored config and the bot falls back to the `.env` it was
   * deployed with.
   */
  async clear(): Promise<void> {
    await this.prisma.setting.deleteMany({ where: { key: { in: Object.values(KEY) } } });
  }
}

/** Entries reduced to the bare id lists the bot's `authorize()` consumes. */
export function entriesToIdLists(entries: AuthzEntries): {
  guildIds: string[];
  allowedChannelIds: string[];
  adminUserIds: string[];
  adminRoleIds: string[];
} {
  return {
    guildIds: entries.guilds.map((e) => e.id),
    allowedChannelIds: entries.channels.map((e) => e.id),
    adminUserIds: entries.adminUsers.map((e) => e.id),
    adminRoleIds: entries.adminRoles.map((e) => e.id),
  };
}
