import type { Logger } from "pino";
import type { AdminApiClient } from "./apiClient.js";
import { authzFromLists, describeAuthz, loadAuthzConfig, type AuthzConfig } from "./authz.js";

/**
 * Where the bot's allowlists come from, and what happens when that source is
 * unreachable.
 *
 * The lists live in the control plane so they can be edited from the dashboard,
 * the API, the CLI or the bot itself. But the bot must keep gating commands
 * correctly while the API is down, and it must never widen a gate because a
 * request failed — so this holds a resolved config in memory, refreshes it on a
 * timer, and treats every failure as "keep what I have".
 *
 * ## Precedence
 *
 * Stored config wins whenever any exists. A deployment that has never touched
 * the dashboard keeps running on its `.env` exactly as before, which is what
 * makes this change invisible to upgrade; the moment an operator saves anything,
 * the stored lists take over completely. Half-and-half was rejected: an
 * allowlist assembled from two sources is one nobody can reason about, and
 * "why is this user still an admin?" should never have the answer "because the
 * environment also has an opinion".
 */

/** Poll rather than push: no socket to keep alive, no missed-event recovery. */
export const DEFAULT_REFRESH_MS = 60_000;

export interface AuthzSourceOptions {
  api: AdminApiClient;
  env: Record<string, string | undefined>;
  log: Logger;
  refreshMs?: number;
}

/** Where the config in force right now came from. Surfaced by `/access show`. */
export type AuthzOrigin = "env" | "stored";

export class AuthzSource {
  private readonly api: AdminApiClient;
  private readonly log: Logger;
  private readonly envConfig: AuthzConfig;
  private readonly refreshMs: number;
  private current: AuthzConfig;
  private currentOrigin: AuthzOrigin = "env";
  /**
   * Which model the control plane says is in force. `allowlist` until told
   * otherwise, so a deployment that has never opted in keeps the old behaviour
   * even before the first refresh lands.
   */
  private currentMode: "allowlist" | "dashboard" = "allowlist";
  private timer: NodeJS.Timeout | null = null;
  /** Set once a refresh has succeeded, so a first-boot failure is loud. */
  private everLoaded = false;

  constructor(opts: AuthzSourceOptions) {
    this.api = opts.api;
    this.log = opts.log;
    this.refreshMs = opts.refreshMs ?? DEFAULT_REFRESH_MS;
    // The environment is the bootstrap value, in force from the first
    // interaction, before any API call has completed.
    this.envConfig = loadAuthzConfig(opts.env);
    this.current = this.envConfig;
  }

  get config(): AuthzConfig {
    return this.current;
  }

  get origin(): AuthzOrigin {
    return this.currentOrigin;
  }

  /**
   * `dashboard` means each command runs with the caller's own operator
   * permissions; `allowlist` means it runs with the bot token's.
   */
  get mode(): "allowlist" | "dashboard" {
    return this.currentMode;
  }

  /** Have we ever successfully read the stored config? */
  get loaded(): boolean {
    return this.everLoaded;
  }

  /**
   * Pull the stored lists and adopt them.
   *
   * Returns the guild set as it stands afterwards so the caller can notice a
   * change: guild-scoped slash commands are registered per guild, so widening
   * the guild list means nothing until the commands are re-registered.
   */
  async refresh(): Promise<{ changed: boolean; guildsChanged: boolean; firstLoad: boolean }> {
    const before = this.current;
    let view;
    try {
      view = await this.api.botAuthz("discord:authz-refresh");
    } catch (err) {
      // Keeping the last-known-good config is the only safe failure mode. The
      // alternatives are both wrong: falling back to `.env` would silently
      // re-admit someone an operator just removed, and clearing the lists
      // would lock everyone out of a working bot because of a 503.
      this.log.warn(
        { err },
        this.everLoaded
          ? "could not refresh Discord allowlists; keeping the ones already in force"
          : "could not read Discord allowlists; running on the environment until the API answers",
      );
      return { changed: false, guildsChanged: false, firstLoad: false };
    }

    // The mode is the control plane's answer regardless of whether any list has
    // been stored: it decides how a command is authorized, not who is listed.
    this.currentMode = view.mode === "dashboard" ? "dashboard" : "allowlist";
    const next = view.configured ? authzFromLists(view.effective) : this.envConfig;
    const origin: AuthzOrigin = view.configured ? "stored" : "env";
    const first = !this.everLoaded;
    this.everLoaded = true;

    const guildsChanged = !sameSet(before.guildIds, next.guildIds);
    const changed = guildsChanged || !sameConfig(before, next) || origin !== this.currentOrigin;
    this.current = next;
    this.currentOrigin = origin;

    if (changed || first) {
      this.log.info({ origin, authz: describeAuthz(next) }, "Discord allowlists in force");
    }
    return { changed, guildsChanged, firstLoad: first };
  }

  /**
   * Begin polling.
   *
   * `onChange` fires when something differed *and* on the first successful
   * load. That first call matters: when the control plane is unreachable at
   * boot the bot starts on its environment, and the pinned guilds only arrive
   * once a refresh finally succeeds — with nothing to compare against, that is
   * not a "change", but it is exactly the moment the caller needs to act on.
   */
  start(onChange?: (result: { guildsChanged: boolean; firstLoad: boolean }) => void): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.refresh().then((result) => {
        if (result.changed || result.firstLoad) onChange?.(result);
      });
    }, this.refreshMs);
    // A refresh timer must never be the reason the process cannot exit.
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

function sameConfig(a: AuthzConfig, b: AuthzConfig): boolean {
  return (
    sameSet(a.guildIds, b.guildIds) &&
    sameSet(a.adminUserIds, b.adminUserIds) &&
    sameSet(a.adminRoleIds, b.adminRoleIds) &&
    sameSet(a.allowedChannelIds, b.allowedChannelIds)
  );
}
