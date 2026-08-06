import type { PrismaClient } from "@prisma/client";

const PAUSE_KEY = "pause_until";
const REMOVAL_MODE_KEY = "chapter_removal_mode";
const SIGNUPS_KEY = "dash_signups_enabled";
const WEBHOOK_SUCCESSES_KEY = "webhook_upload_successes";
const GITHUB_AUTO_SYNC_KEY = "github_auto_sync";
export const VALID_REMOVAL_MODES = ["unavailable", "delete"] as const;
export type RemovalMode = (typeof VALID_REMOVAL_MODES)[number];
export const DEFAULT_REMOVAL_MODE: RemovalMode = "unavailable";

/** Pause gate, schedule overrides, disabled extensions, removal mode -
 * replaces the SQLite state store with the same semantics. */
export class SettingsStore {
  constructor(private readonly prisma: PrismaClient) {}

  async setSetting(key: string, value: string): Promise<void> {
    await this.prisma.setting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  }

  async getSetting(key: string): Promise<string | null> {
    const row = await this.prisma.setting.findUnique({ where: { key } });
    return row?.value ?? null;
  }

  async clearSetting(key: string): Promise<void> {
    await this.prisma.setting.deleteMany({ where: { key } });
  }

  // -- pause gate (Infinity = paused until explicit resume) --

  async setPauseUntil(epochSeconds: number): Promise<void> {
    if (epochSeconds <= 0) return this.clearSetting(PAUSE_KEY);
    await this.setSetting(PAUSE_KEY, epochSeconds === Infinity ? "inf" : String(epochSeconds));
  }

  async getPauseUntil(): Promise<number> {
    const raw = await this.getSetting(PAUSE_KEY);
    if (!raw) return 0;
    if (raw === "inf") return Infinity;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  async isPaused(): Promise<boolean> {
    return Date.now() / 1000 < (await this.getPauseUntil());
  }

  // -- removal mode --

  async getRemovalMode(): Promise<RemovalMode> {
    const value = await this.getSetting(REMOVAL_MODE_KEY);
    return (VALID_REMOVAL_MODES as readonly string[]).includes(value ?? "")
      ? (value as RemovalMode)
      : DEFAULT_REMOVAL_MODE;
  }

  async setRemovalMode(mode: RemovalMode): Promise<void> {
    await this.setSetting(REMOVAL_MODE_KEY, mode);
  }

  // -- dashboard self-signup gate --

  /**
   * Off unless explicitly turned on: with signups enabled, anyone who can
   * complete a Discord login creates an (unapproved) account row.
   */
  async getSignupsEnabled(): Promise<boolean> {
    return (await this.getSetting(SIGNUPS_KEY)) === "true";
  }

  async setSignupsEnabled(enabled: boolean): Promise<void> {
    await this.setSetting(SIGNUPS_KEY, enabled ? "true" : "false");
  }

  // -- webhook verbosity --

  /**
   * Whether a per-chapter embed is sent for uploads that SUCCEEDED.
   *
   * Python sent one either way, which on a normal run means the channel is
   * almost entirely "Success: True"; and a failure, the only thing anyone
   * needs to act on, scrolls past between them. Off by default so the channel
   * carries exceptions rather than a transcript; the run-level "Found N
   * chapters" embed already says the work happened.
   *
   * Failures are NOT configurable: there is no reading of this system where
   * silently dropping a failed upload is what the operator wanted.
   */
  async getWebhookUploadSuccesses(): Promise<boolean> {
    return (await this.getSetting(WEBHOOK_SUCCESSES_KEY)) === "true";
  }

  async setWebhookUploadSuccesses(enabled: boolean): Promise<void> {
    await this.setSetting(WEBHOOK_SUCCESSES_KEY, enabled ? "true" : "false");
  }

  // -- github auto-sync --

  /**
   * Whether the scheduler polls the configured GitHub repos and publishes what
   * changed.
   *
   * On by default. The push webhook is the fast path, but it fails silently -
   * an unregistered hook or a dropped delivery just means extensions quietly
   * stop updating; and polling is the only check that does not depend on
   * anything inbound. Publishing is idempotent, so the two overlapping costs
   * nothing.
   *
   * Turn it off to freeze the fleet on the currently published bundles, which
   * is what you want while investigating a bad extension.
   */
  async getGithubAutoSync(): Promise<boolean> {
    return (await this.getSetting(GITHUB_AUTO_SYNC_KEY)) !== "false";
  }

  async setGithubAutoSync(enabled: boolean): Promise<void> {
    await this.setSetting(GITHUB_AUTO_SYNC_KEY, enabled ? "true" : "false");
  }

  // -- schedule overrides --

  async getScheduleOverrides(): Promise<
    Record<string, { hour: number; minute: number; day?: number }>
  > {
    const rows = await this.prisma.scheduleOverride.findMany();
    const out: Record<string, { hour: number; minute: number; day?: number }> = {};
    for (const row of rows) {
      out[row.extension] = {
        hour: row.hour,
        minute: row.minute,
        ...(row.day !== null ? { day: row.day } : {}),
      };
    }
    return out;
  }

  async upsertSchedule(extension: string, hour: number, minute: number, day?: number): Promise<void> {
    await this.prisma.scheduleOverride.upsert({
      where: { extension },
      create: { extension, hour, minute, day: day ?? null },
      update: { hour, minute, day: day ?? null },
    });
  }

  async removeSchedule(extension: string): Promise<boolean> {
    const res = await this.prisma.scheduleOverride.deleteMany({ where: { extension } });
    return res.count > 0;
  }

  // -- disabled extensions --

  async listDisabled(): Promise<string[]> {
    const rows = await this.prisma.disabledExtension.findMany();
    return rows.map((r) => r.extension).sort();
  }

  async isDisabled(extension: string): Promise<boolean> {
    return (await this.prisma.disabledExtension.findUnique({ where: { extension } })) !== null;
  }

  async disable(extension: string): Promise<void> {
    await this.prisma.disabledExtension.upsert({
      where: { extension },
      create: { extension },
      update: {},
    });
  }

  async enable(extension: string): Promise<void> {
    await this.prisma.disabledExtension.deleteMany({ where: { extension } });
  }
}

export class AuditLog {
  constructor(private readonly prisma: PrismaClient) {}

  async record(actor: string, action: string, subject?: string, detail?: unknown): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        actor: actor.slice(0, 256),
        action: action.slice(0, 128),
        subject: subject?.slice(0, 512) ?? null,
        detail: detail === undefined ? undefined : (detail as object),
      },
    });
  }

  /**
   * Several events in one statement.
   *
   * For a bulk operator action the per-subject rows are what keep "why was this
   * chapter deleted?" answerable; a lookup by `subject` finds nothing if a
   * batch only writes one summary row; but two hundred sequential inserts
   * inside a request is a cost with no upside.
   */
  async recordMany(
    rows: readonly { actor: string; action: string; subject?: string; detail?: unknown }[],
  ): Promise<void> {
    if (rows.length === 0) return;
    await this.prisma.auditEvent.createMany({
      data: rows.map((row) => ({
        actor: row.actor.slice(0, 256),
        action: row.action.slice(0, 128),
        subject: row.subject?.slice(0, 512) ?? null,
        detail: row.detail === undefined ? undefined : (row.detail as object),
      })),
    });
  }

  async recent(limit = 100): Promise<unknown[]> {
    return this.prisma.auditEvent.findMany({ orderBy: { createdAt: "desc" }, take: limit });
  }
}
