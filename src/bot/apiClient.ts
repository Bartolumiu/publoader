/**
 * Typed client for the admin half of the core API, as consumed by the Discord
 * bot (see src/core/api/routes/admin.ts for the server side).
 *
 * The bot is an API client and nothing else: it holds no database URL, no
 * MangaDex credential, and no Docker socket. Everything it can do to the
 * platform, it does through one bearer token over HTTPS; which means the blast
 * radius of a compromised bot host is exactly the set of scopes on that token.
 */
import type { Logger } from "../logging.js";
// The scope taxonomy is shared with the server rather than restated here: a
// scope name the bot invents is a 403 nobody can act on, and scopes.ts is a
// dependency-free constant module, so importing it costs the bot nothing.
import type { Scope } from "../core/api/scopes.js";
import type { BotAuthzView } from "../core/api/routes/botAuthz.js";
import type { AuthzEntry, AuthzListName } from "../core/store/botAuthz.js";

/**
 * Where the bot looks for the control plane when CORE_URL is unset. Matches
 * worker/coreApi.ts: the public deployment, not a LAN address, because the bot
 * is expected to run wherever is convenient.
 */
export const DEFAULT_CORE_URL = "https://publoader.ardax.dev";

export type { Scope, BotAuthzView };

/** Lists omitted from a patch are left exactly as they are. */
export type BotAuthzPatch = Partial<Record<AuthzListName, (string | AuthzEntry)[]>>;

/** Any non-2xx answer from the admin API. */
export class AdminApiError extends Error {
  readonly status: number;
  /** The API's own `{error: "..."}` text when it sent one, else the raw body. */
  readonly detail: string;
  readonly scope: Scope;
  readonly retryAfterSeconds: number | undefined;
  /**
   * Scopes the token actually holds. A 403 from `requireScope` reports them,
   * which is the difference between "forbidden" and "you have A and B, you
   * need C".
   */
  readonly held: readonly string[] | undefined;

  constructor(opts: {
    status: number;
    detail: string;
    scope: Scope;
    method: string;
    path: string;
    retryAfterSeconds?: number | undefined;
    held?: readonly string[] | undefined;
  }) {
    super(`${opts.status} from ${opts.method} ${opts.path}: ${opts.detail}`);
    this.name = "AdminApiError";
    this.status = opts.status;
    this.detail = opts.detail;
    this.scope = opts.scope;
    this.retryAfterSeconds = opts.retryAfterSeconds;
    this.held = opts.held;
  }

  /** True when the credential itself was rejected, as opposed to the request. */
  get isAuth(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

/** Transport-level failure: DNS, connection reset, TLS, timeout. */
export class AdminNetworkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AdminNetworkError";
  }
}

/**
 * Turn a thrown error into something an operator reading Discord can act on.
 * Every branch names the next step, because "403 Forbidden" in a chat window
 * with no logs in front of you is not actionable.
 */
export function describeApiError(err: unknown): string {
  if (err instanceof AdminApiError) {
    switch (err.status) {
      case 401:
        return (
          `**401: the bot's API token was rejected.** The API said: \`${err.detail}\`\n` +
          "Check `BOT_API_TOKEN`: it must be a token the core currently accepts, " +
          "and it must be sent to the right `CORE_URL`. If the token was rotated, " +
          "redeploy the bot with the new value."
        );
      case 403: {
        const holds =
          err.held && err.held.length > 0
            ? `\nThe token currently holds: ${err.held.map((s) => `\`${s}\``).join(", ")}.`
            : "";
        return (
          `**403: the bot's API token lacks the \`${err.scope}\` scope.** The API said: \`${err.detail}\`${holds}\n` +
          `Mint a replacement token that includes \`${err.scope}\` (\`publoader-admin tokens create\`), or accept that this command is not available to the bot.`
        );
      }
      case 404:
        return `**404: not found.** The API said: \`${err.detail}\``;
      case 409:
        // 409 is the API's "your request is valid but the world says no":
        // paused platform, uncancellable job, un-skippable row.
        return `**409: conflict.** The API said: \`${err.detail}\``;
      case 429: {
        const wait = err.retryAfterSeconds
          ? `Wait ${err.retryAfterSeconds}s and try again.`
          : "Wait a few seconds and try again.";
        return `**429: rate limited by the admin API.** ${wait} The API said: \`${err.detail}\``;
      }
      case 503:
        return `**503: that part of the API is not available on this deployment.** The API said: \`${err.detail}\``;
      default:
        return `**${err.status} from the admin API.** It said: \`${err.detail}\``;
    }
  }
  if (err instanceof AdminNetworkError) {
    return `**Could not reach the core API.** ${err.message}\nCheck \`CORE_URL\` and that core-api is up.`;
  }
  return `**Unexpected failure:** \`${err instanceof Error ? err.message : String(err)}\``;
}

// ---- response shapes -------------------------------------------------------
// Structural subsets of what admin.ts returns: only the fields the bot renders.
// Prisma rows come back verbatim, so these intentionally do not try to mirror
// the whole model; a field added server-side must not break the bot.

export interface Stats {
  jobs: Record<string, number>;
  uploadTasks: { kind: string; state: string; count: number }[];
  workers: Record<string, number>;
  quarantined: number;
  paused: boolean;
}

export interface WorkerSummary {
  id: string;
  name: string;
  status: string;
  trust: string;
  capabilities?: unknown;
  lastHeartbeatAt: string | null;
  agentVersion: string | null;
  createdAt: string;
}

export interface RunSummary {
  id: string;
  extension: string;
  kind: string;
  state: string;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  triggeredBy?: string | null;
}

export interface JobSummary {
  id: string;
  runId?: string;
  extension?: string;
  state: string;
  attempt: number;
  segmentIndex?: number | null;
  segmentTotal?: number | null;
  lastError?: string | null;
  updatedAt?: string;
  workerId?: string | null;
}

export interface RunDetail extends RunSummary {
  jobs: JobSummary[];
}

export interface ExtensionSummary {
  name: string;
  version: string;
  sha256: string;
  disabled: boolean;
  publishedAt: string;
}

export interface ScheduleEntry {
  id?: string;
  enabled?: boolean;
  hour: number;
  minute: number;
  /** Monday=0 … Sunday=6. Empty = every day. */
  days: number[];
  kind: "UPDATE" | "CLEAN" | "FORCE";
  label?: string;
}

export interface Schedules {
  defaults: Record<string, ScheduleEntry[]>;
  overrides: Record<string, ScheduleEntry[]>;
  effective: Record<string, ScheduleEntry[]>;
}

export interface ExtensionSchedule {
  extension: string;
  manifest: ScheduleEntry[];
  entries: ScheduleEntry[];
  effective: ScheduleEntry[];
  source: "operator" | "manifest";
}

export interface QuarantineEntry {
  id: string;
  jobId: string;
  workerId: string | null;
  /** Resolved by the core; null when the worker row is gone. */
  workerName?: string | null;
  rejectReason: string | null;
  createdAt: string;
  /** Present only when this quarantine has been acknowledged in the error feed. */
  cleared?: { at: string; by: string; note: string | null };
}

export interface UntrackedEntry {
  id: string;
  extension: string;
  mangaId: string;
  title?: string | null;
  /** The scraped series name. `title` is the legacy spelling of the same thing. */
  mangaName?: string | null;
  mangaUrl?: string | null;
  mdMangaId?: string | null;
  state: string;
  createdAt: string;
}

/**
 * A MangaDex title the search offers as a candidate for an untracked series.
 * Mirrors the `results` shape of GET /api/v1/admin/mangadex/search.
 */
export interface MdTitleCandidate {
  id: string;
  title: string;
  altTitles: string[];
  url: string;
  /** Matches the scraped name by the same rule that refuses a duplicate create. */
  likely: boolean;
}

/**
 * Mirrors ResolvedSource in core/store/sourceLinks.ts, narrowed to what the
 * bot renders. `via` is carried because "which extension is this" and "how do
 * you know" are the same question when the answer decides where uploads go.
 */
export interface SourceMatch {
  extension: string;
  mangaId: string | null;
  namespace: string | null;
  via: "queue" | "known-id" | "rule" | "host";
  untracked: { id: string; mangaName: string; state: string; mdMangaId: string | null } | null;
  tracked: { mdMangaId: string; namespace: string; source: string } | null;
  rule?: { segments: number; samples: number; agreement: number };
}

/** Mirrors SourceResolution in core/store/sourceLinks.ts. */
export interface SourceResolution {
  url: string;
  normalised: string | null;
  host: string | null;
  match: SourceMatch | null;
  candidates: string[];
  namespaces: string[];
  reason?: string;
}

/** Mirrors the answer of POST /api/v1/admin/source/map. */
export interface SourceMapResult {
  ok: boolean;
  changed: boolean;
  dryRun?: boolean;
  outcome: "added" | "repointed" | "unchanged";
  extension: string;
  namespace: string;
  mangaId: string;
  mdMangaId: string;
  previousMdMangaId?: string | null;
  untrackedRow?: string | null;
  untrackedNote?: string;
  resolution: SourceResolution;
}

/** One line of a pasted batch, as POST /api/v1/admin/source/map/batch judged it. */
export interface SourceBatchRow {
  line?: number;
  sourceUrl: string;
  extension?: string | null;
  namespace?: string;
  mangaId?: string;
  mdMangaId?: string;
  via?: string;
  queued?: string | null;
  outcome: string;
  detail?: string;
}

/** Mirrors the report of POST /api/v1/admin/source/map/batch. */
export interface SourceBatchReport {
  dryRun: boolean;
  parseErrors: { line: number; text: string; reason: string }[];
  added: number;
  updated: number;
  unchanged: number;
  failed: number;
  unresolved: number;
  closedQueueRows: number;
  untrackedNote?: string;
  results: SourceBatchRow[];
}

/** Mirrors the report of POST /api/v1/admin/untracked/automap. */
export interface AutomapReport {
  dryRun: boolean;
  considered: number;
  ambiguous: number;
  unmatched: number;
  remaining: number;
  mapped: { id: string; extension: string; mangaName: string; mdMangaId: string; titleUrl: string }[];
}

export interface TrackedEntry {
  extension: string;
  mangaId: string;
  mdMangaId: string;
  /** The extension's catalogue; empty for the flat id space most of them have. */
  namespace?: string | null;
  source?: string | null;
  createdAt: string;
  /** Set while the series is suppressed from runs; see the recheck cooldown. */
  recheckAfter?: string | null;
  cooldownDays?: number | null;
  pausedBy?: string | null;
  pauseReason?: string | null;
}

export interface AuditEntry {
  id?: string;
  actor: string;
  action: string;
  target?: string | null;
  createdAt: string;
  metadata?: unknown;
}

/** What POST /enroll-tokens returns: the secret, once, plus its expiry. */
export interface EnrollToken {
  token: string;
  expiresAt: string;
}

export interface TriggerRunResult {
  runId: string;
  created: boolean;
}

/** A row from the uploader's queue; the view legacy `queue_peek` gave. */
export interface UploadTask {
  id: string;
  kind: string;
  state: string;
  dedupeKey: string;
  attempt: number;
  maxAttempts: number;
  notBefore?: string | null;
  leaseExpiresAt?: string | null;
  lastError?: string | null;
  updatedAt: string;
}

/**
 * MangaDex session state. Deliberately says whether a token exists and when it
 * goes stale, never what it is.
 */
export interface MdAuthState {
  hasAccess: boolean;
  hasRefresh: boolean;
  expiresAt: string | null;
  expired: boolean;
  expiresInSeconds: number | null;
}

/** One entry in the merged error feed that stands in for legacy `logs`. */
export interface ErrorEntry {
  at: string;
  kind: string;
  /** Which table it came from, and what `clear`/`restore` take as `source`. */
  source: "job" | "upload-task" | "submission";
  subject: string;
  message: string;
  id: string;
  /** Set only on entries an operator has already dealt with. */
  cleared?: { at: string; by: string; note: string | null };
}

/** Which acknowledged entries a feed read should include. */
export type ErrorClearedFilter = "without" | "with" | "only";

export type UploadTaskKind = "UPLOAD" | "EDIT" | "DELETE" | "UNAVAILABLE";
export type UploadTaskState = "PENDING" | "LEASED" | "DONE" | "FAILED" | "DEAD_LETTER";

/**
 * What a reconcile pass found. Mirrors ReconcileReport in
 * core/md/chapterReconcile.ts, narrowed to the fields the bot renders.
 */
/** One title's footprint in an archive, as `/chapters/series` reports it. */
export interface ArchiveSeries {
  mdMangaId: string;
  mangaName: string | null;
  extensions: string[];
  count: number;
  at: string;
}

export interface ArchiveSeriesReport {
  archive: string;
  series: ArchiveSeries[];
  limit: number;
  capped: boolean;
}

/** What a re-check would cover, and the run it started if it did. */
export interface SeriesRecheck {
  dryRun: boolean;
  /** Which instrument answered: one title, or a whole extension. */
  target: "series" | "extension";
  extension: string;
  removalMode: string;
  /** Series target only: the publisher's own id for the title. */
  mangaId?: string;
  onMangadex: number | null;
  carded: number | null;
  candidates: number | null;
  /** Extension target only. */
  trackedSeries?: number;
  knownChapters?: number;
  publishesCatalogue: boolean;
  runId?: string;
  created?: boolean;
  note: string;
}

/** Mirrors ReconcileStep in core/md/reconcilePlan.ts. */
export interface ChapterReconcileStep {
  id: string;
  label: string;
  state: "pending" | "running" | "done" | "skipped" | "failed";
  done: number;
  total: number | null;
  note: string | null;
}

/** Mirrors DuplicateRunState in core/md/duplicateRunner.ts. */
export interface ChapterDuplicateStatus {
  state: "idle" | "running" | "done" | "failed";
  progress?: { steps: ChapterReconcileStep[] };
  report?: ChapterDuplicateReport;
  error?: string;
}

/**
 * What a duplicate scan found. Mirrors DuplicateScanReport in
 * core/md/duplicateScan.ts, narrowed to the fields the bot renders.
 */
export interface ChapterDuplicateReport {
  apply: boolean;
  groups: {
    extension: string;
    groupId: string;
    chaptersOnMd: number;
    seriesScanned: number;
    seriesWithDuplicates: number;
    duplicatesFound: number;
    queued: number;
  }[];
  series: {
    extension: string;
    mdMangaId: string;
    mangaName: string | null;
    chaptersOnMd: number;
    removeCount: number;
  }[];
  seriesScanned: number;
  seriesWithDuplicates: number;
  duplicatesFound: number;
  queued: number;
  blocked: number;
  truncatedSeries: number;
}

/** Mirrors ReconcileRunState in core/md/reconcileRunner.ts. */
export interface ChapterReconcileStatus {
  state: "idle" | "running" | "done" | "failed";
  progress?: { steps: ChapterReconcileStep[] };
  report?: ChapterReconcileReport;
  error?: string;
}

export interface ChapterReconcileReport {
  dryRun: boolean;
  groups: {
    extension: string;
    groupId: string;
    total: number;
    carded: number;
    recorded: number;
    hiddenOnMangadex: number;
    live: number;
    untracked: number;
    adopted: number;
    adoptedWithId: number;
  }[];
  unavailableFound: number;
  unavailableRecorded: number;
  untrackedFound: number;
  adoptedRecorded: number;
  idsRecorded: number;
  scanned: number;
  skippedByGroupWalk: number;
  deletedFound: number;
  deletedRecorded: number;
  hiddenOnMangadex: string[];
}

/**
 * What the bot can say about its own credential. `scopes` is populated only if
 * the deployment exposes token introspection; see `tokenSelf()`.
 */
export interface TokenIdentity {
  actor?: string;
  scopes?: string[];
  expiresAt?: string | null;
  note?: string | null;
}

export interface RoleBaseline {
  role: string;
  scopes: string[];
  defaults: string[];
  custom: boolean;
  tunable: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface PermissionCatalogue {
  scopes: { name: string; description: string }[];
  presets: Record<string, string[]>;
  tunableRoles: string[];
  roles: RoleBaseline[];
}

export interface UserPermissions {
  userId: string;
  email: string;
  role: string;
  baseline: string[];
  extraScopes: string[];
  deniedScopes: string[];
  effective: string[];
  tunable: boolean;
}

export type UntrackedState = "NEW" | "CREATING" | "CREATED" | "TRACKED" | "FAILED" | "SKIPPED";
export type RunKind = "UPDATE" | "CLEAN" | "FORCE";
export type RemovalMode = "unavailable" | "delete";
export type WorkerAction = "drain" | "activate" | "revoke";

interface RequestSpec {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  scope: Scope;
  /** Attributed to this human in the audit log via `x-actor`. */
  actor: string;
  json?: unknown;
  query?: Record<string, string | number | undefined>;
  timeoutMs?: number;
}

/** Which record of a chapter to read: the live mirror, or an archive. */
export const CHAPTER_ARCHIVES = ["uploaded", "edited", "unavailable", "deleted"] as const;
export type ChapterArchive = (typeof CHAPTER_ARCHIVES)[number];

export interface ChapterQuery {
  archive?: ChapterArchive;
  extension?: string;
  language?: string;
  mdMangaId?: string;
  search?: string;
  limit?: number;
}

export interface ChapterRow {
  mdChapterId?: string | null;
  chapterNumber?: string | null;
  chapterTitle?: string | null;
  chapterLanguage?: string | null;
  extension?: string | null;
  mdMangaId?: string | null;
  at?: string | null;
  [key: string]: unknown;
}

export interface ChapterPage {
  archive: string;
  chapters: ChapterRow[];
  total?: number;
  /** Global counts per archive, so a narrow filter cannot hide the picture. */
  totals?: Record<string, number>;
  nextCursor?: string | null;
}

/** What a map sync did, or would have done. */
export interface MapSyncReport {
  dryRun?: boolean;
  changed?: number;
  added?: number;
  removed?: number;
  extensions?: string[];
  /** Set when the shrink guard refused a suspiciously large removal. */
  blocked?: string | null;
  [key: string]: unknown;
}

export interface AuditSearchQuery {
  q?: string;
  actor?: string;
  action?: string;
  subject?: string;
  limit?: number;
}

export interface EnrollTokenRow {
  id: string;
  trust: string;
  note?: string | null;
  createdAt: string;
  expiresAt?: string | null;
  usedAt?: string | null;
  usedByWorkerName?: string | null;
  revoked?: boolean;
}

export interface ExtensionConfigView {
  extension?: string;
  aliases?: unknown[];
  multiChapters?: unknown[];
  languages?: unknown[];
  overrideOptions?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface QueuePurgeBody {
  kind?: UploadTaskKind;
  state?: UploadTaskState;
  extension?: string;
  q?: string;
  /** True asks "how many would this hit"; false actually deletes. */
  dryRun: boolean;
  confirm?: boolean;
  includeCompleted?: boolean;
}

export interface QueuePurgeResult {
  dryRun?: boolean;
  matched?: number;
  deleted?: number;
  capped?: boolean;
  error?: string;
}

/** How many chapters go out, how often, and how far apart. */
export interface UploadScheduleValues {
  perDay?: number;
  perMangaPerDay?: number;
  intervalHours?: number;
  /** 0 means auto: spread a day evenly and do not pace enqueueing. */
  spacingSeconds?: number;
}

export type UploadSchedulePatch = UploadScheduleValues;

export interface UploadScheduleView {
  global: UploadScheduleValues;
  overrides: Record<string, UploadScheduleValues>;
  defaults: UploadScheduleValues;
  scope: string;
  priority: string[];
  paused: string[];
}

/** How hard a worker is allowed to hit one publisher. */
export interface FetchThrottleValues {
  minIntervalMs?: number;
  jitter?: boolean;
  jitterRatio?: number;
}

export type FetchThrottlePatch = FetchThrottleValues;

export interface FetchThrottleView {
  global: FetchThrottleValues;
  overrides: Record<string, FetchThrottleValues>;
  defaults: FetchThrottleValues;
}

/** One line from the platform's own log table. */
export interface LogLine {
  createdAt: string;
  /** pino levels: 10 trace, 20 debug, 30 info, 40 warn, 50 error. */
  level: number;
  service: string;
  component?: string | null;
  msg: string;
  runId?: string | null;
  jobId?: string | null;
}

export interface LogQuery {
  limit?: number;
  minLevel?: number;
  service?: string;
  q?: string;
  since?: string;
}

/** One entry in the merged operational feed. */
export interface ActivityEvent {
  kind: string;
  severity: string;
  at: string;
  subject?: string | null;
  message?: string | null;
  extension?: string | null;
}

export interface ActivityQuery {
  severity?: "error" | "warn" | "info" | "all";
  hours?: number;
  extension?: string;
  q?: string;
  limit?: number;
}

export interface AdminApiClientOptions {
  baseUrl?: string | undefined;
  token: string;
  log?: Logger | undefined;
  /** Overridable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch | undefined;
  /** Set via `onBehalfOf()`; see the field of the same name. */
  actingForDiscordId?: string | undefined;
}

export class AdminApiClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly log: Logger | undefined;
  private readonly fetchImpl: typeof fetch;
  /** Learned from a 403's `held` array; see `request()`. */
  private lastKnownScopes: readonly string[] | undefined;
  /**
   * Discord user this client acts for, sent as `x-on-behalf-of-discord`.
   *
   * When set, the control plane runs each request with that person's dashboard
   * scopes intersected with this token's — so a command is carried out with the
   * authority of whoever asked for it rather than the bot's own.
   */
  private readonly actingForDiscordId: string | undefined;
  private readonly opts: AdminApiClientOptions;

  constructor(opts: AdminApiClientOptions) {
    this.opts = opts;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_CORE_URL).replace(/\/+$/, "");
    this.token = opts.token;
    this.log = opts.log;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.actingForDiscordId = opts.actingForDiscordId;
  }

  /**
   * A client that makes every call on behalf of one Discord user.
   *
   * A new instance rather than a mutable field, because commands run
   * concurrently: setting "who am I acting for" on a shared client would let
   * one person's command be authorized as another's.
   */
  onBehalfOf(discordUserId: string): AdminApiClient {
    return new AdminApiClient({ ...this.opts, actingForDiscordId: discordUserId });
  }

  /**
   * A masked form of the token, safe to print. Enough to tell two tokens apart
   * and to see at a glance whether the bot was handed a scoped `pa_…` token or
   * the root admin token.
   */
  get tokenFingerprint(): string {
    const t = this.token;
    if (t.length <= 8) return "*".repeat(t.length);
    return `${t.slice(0, 4)}…${t.slice(-4)} (${t.length} chars)`;
  }

  /**
   * True when the token looks like a scoped per-client credential rather than
   * the platform's root ADMIN_TOKEN. Prefix-based and therefore a hint, not a
   * guarantee; but a bot running on the root token is worth warning about on
   * every startup, and this is the only signal available client-side.
   */
  get looksScoped(): boolean {
    return this.token.startsWith("pa_");
  }

  /**
   * Scopes observed on this token, if any command has been refused for lacking
   * one. Not authoritative, it is empty until the first 403, but it is the
   * only scope information available without an introspection endpoint.
   */
  get observedScopes(): readonly string[] | undefined {
    return this.lastKnownScopes;
  }

  private async request<T>(spec: RequestSpec): Promise<T> {
    const url = new URL(this.baseUrl + spec.path);
    for (const [key, value] of Object.entries(spec.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: "application/json",
      // The audit log records the principal, not the process: without this
      // every action taken through the bot would read as one anonymous robot.
      "x-actor": spec.actor,
    };
    if (this.actingForDiscordId) {
      // The control plane resolves this to the linked operator account and runs
      // the request with that account's scopes, intersected with this token's.
      headers["x-on-behalf-of-discord"] = this.actingForDiscordId;
    }
    let body: string | undefined;
    if (spec.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(spec.json);
    }

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: spec.method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(spec.timeoutMs ?? 20_000),
      });
    } catch (err) {
      throw new AdminNetworkError(`${spec.method} ${url.pathname} failed: ${(err as Error).message}`, {
        cause: err,
      });
    }

    const text = await res.text().catch(() => "");
    if (!res.ok) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const held = extractHeldScopes(text);
      // A 403 is the only place the API volunteers what the token can do. Keep
      // it so `/whoami` can answer honestly without an introspection endpoint.
      if (held) this.lastKnownScopes = held;
      throw new AdminApiError({
        status: res.status,
        detail: extractError(text) ?? `${res.status} ${res.statusText}`,
        scope: spec.scope,
        method: spec.method,
        path: url.pathname,
        retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
        held,
      });
    }
    this.log?.debug({ method: spec.method, path: url.pathname, status: res.status }, "admin api call");
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new AdminNetworkError(`${spec.method} ${url.pathname} returned non-JSON: ${text.slice(0, 200)}`);
    }
  }

  // ---- the bot's own allowlists ----

  /**
   * Who this bot answers to, as the control plane currently stores it.
   *
   * The bot reads its own gating over the same API every other surface uses
   * rather than owning a private copy, so "who may operate the bot" has exactly
   * one answer no matter where the question is asked.
   */
  botAuthz(actor: string): Promise<BotAuthzView> {
    return this.request<BotAuthzView>({
      method: "GET",
      path: "/api/v1/admin/discord/authz",
      scope: "users:admin",
      actor,
    });
  }

  setBotAuthz(actor: string, patch: BotAuthzPatch): Promise<BotAuthzView> {
    return this.request<BotAuthzView>({
      method: "PUT",
      path: "/api/v1/admin/discord/authz",
      scope: "users:admin",
      actor,
      json: patch,
    });
  }

  resetBotAuthz(actor: string): Promise<BotAuthzView> {
    return this.request<BotAuthzView>({
      method: "DELETE",
      path: "/api/v1/admin/discord/authz",
      scope: "users:admin",
      actor,
    });
  }

  // ---- the published catalogue, read-only ----

  /**
   * What this platform has on MangaDex, by archive.
   *
   * Read only, and deliberately so: every chapter *write* route is guarded by
   * `requireAdminRole`, which refuses an api-token principal outright — no
   * scope and no impersonated role gets past it. Deleting a chapter on
   * MangaDex is irreversible, and the platform's answer is that it happens from
   * the dashboard by a person, never through a bot's credential.
   */
  chapters(actor: string, query: ChapterQuery): Promise<ChapterPage> {
    return this.request({
      method: "GET",
      path: "/api/v1/admin/chapters",
      scope: "chapters:read",
      actor,
      query: {
        archive: query.archive,
        extension: query.extension,
        language: query.language,
        mdMangaId: query.mdMangaId,
        search: query.search,
        limit: query.limit,
      },
    });
  }

  chapterCollisions(
    actor: string,
    query: { extension?: string; includeAcknowledged?: boolean; limit?: number },
  ): Promise<{ collisions?: unknown[]; total?: number; [key: string]: unknown }> {
    return this.request({
      method: "GET",
      path: "/api/v1/admin/chapters/collisions",
      scope: "chapters:read",
      actor,
      query: {
        extension: query.extension,
        includeAcknowledged: query.includeAcknowledged ? "true" : undefined,
        limit: query.limit,
      },
    });
  }

  // ---- the series map, the audit log, and pending enrolments ----

  /**
   * Push the series map to its git repository.
   *
   * The endpoint defaults `dryRun` to **false**, which is the one default in
   * the admin API that acts rather than reports. Every caller here passes it
   * explicitly for that reason; see the `/maps sync` command, which inverts the
   * default so a bare invocation cannot write.
   */
  syncMaps(actor: string, opts: { dryRun: boolean; extensions?: string[] }): Promise<MapSyncReport> {
    return this.request({
      method: "POST",
      path: "/api/v1/admin/maps/sync",
      scope: "tracked:write",
      actor,
      json: { dryRun: opts.dryRun, extensions: opts.extensions ?? [] },
    });
  }

  searchAudit(actor: string, query: AuditSearchQuery): Promise<{ events: AuditEntry[]; total?: number }> {
    return this.request({
      method: "GET",
      path: "/api/v1/admin/audit/search",
      scope: "audit:read",
      actor,
      query: {
        q: query.q,
        actor: query.actor,
        action: query.action,
        subject: query.subject,
        limit: query.limit,
      },
    });
  }

  enrollTokens(actor: string): Promise<{ tokens: EnrollTokenRow[] }> {
    return this.request({
      method: "GET",
      path: "/api/v1/admin/enroll-tokens",
      scope: "workers:read",
      actor,
    });
  }

  extensionConfig(actor: string, extension: string): Promise<ExtensionConfigView> {
    return this.request({
      method: "GET",
      path: `/api/v1/admin/extensions/${encodeURIComponent(extension)}/config`,
      scope: "extensions:read",
      actor,
    });
  }

  // ---- clearing up after an incident ----

  /**
   * Delete queued upload tasks matching a filter.
   *
   * `dryRun` defaults to true server-side and this keeps that: the count comes
   * back before anything is deleted, because "how many would that hit?" is the
   * question an operator actually has, and a purge is not undoable.
   */
  purgeQueue(actor: string, body: QueuePurgeBody): Promise<QueuePurgeResult> {
    return this.request({
      method: "POST",
      path: "/api/v1/admin/queues/purge",
      scope: "runs:write",
      actor,
      json: body,
    });
  }

  /** Re-space pending uploads so they go out `gapSeconds` apart. */
  restaggerQueue(
    actor: string,
    gapSeconds: number,
    kind: UploadTaskKind,
  ): Promise<{ moved: number; gapSeconds: number }> {
    return this.request({
      method: "POST",
      path: "/api/v1/admin/queues/restagger",
      scope: "runs:write",
      actor,
      json: { gapSeconds, kind },
    });
  }

  cancelRun(actor: string, runId: string): Promise<{ ok: boolean }> {
    return this.request({
      method: "POST",
      path: `/api/v1/admin/runs/${encodeURIComponent(runId)}/cancel`,
      scope: "runs:write",
      actor,
    });
  }

  cancelAllRuns(actor: string, extension?: string): Promise<{ ok: boolean; runs?: number; jobs?: number }> {
    return this.request({
      method: "POST",
      path: "/api/v1/admin/runs/cancel-all",
      scope: "runs:write",
      actor,
      json: extension ? { extension } : {},
    });
  }

  // ---- pacing: how fast we upload, and how fast we fetch ----

  uploadSchedule(actor: string): Promise<UploadScheduleView> {
    return this.request({
      method: "GET",
      path: "/api/v1/admin/upload-schedule",
      scope: "settings:read",
      actor,
    });
  }

  setUploadSchedule(actor: string, patch: UploadSchedulePatch): Promise<{ global: UploadScheduleValues }> {
    return this.request({
      method: "POST",
      path: "/api/v1/admin/upload-schedule",
      scope: "settings:write",
      actor,
      json: patch,
    });
  }

  /** An empty patch clears the override, returning the extension to the global. */
  setUploadScheduleFor(
    actor: string,
    extension: string,
    patch: UploadSchedulePatch,
  ): Promise<{ ok: boolean; extension: string; cleared: boolean }> {
    return this.request({
      method: "POST",
      path: `/api/v1/admin/upload-schedule/${encodeURIComponent(extension)}`,
      scope: "settings:write",
      actor,
      json: patch,
    });
  }

  /** Which extensions jump the upload queue. Replaces the whole list. */
  setUploadPriority(actor: string, extensions: string[]): Promise<{ ok: boolean; extensions?: string[] }> {
    return this.request({
      method: "POST",
      path: "/api/v1/admin/upload-schedule/priority",
      scope: "settings:write",
      actor,
      json: { extensions },
    });
  }

  /** Extensions held out of uploading entirely. Replaces the whole list. */
  setUploadPaused(actor: string, extensions: string[]): Promise<{ ok: boolean; extensions?: string[] }> {
    return this.request({
      method: "POST",
      path: "/api/v1/admin/upload-schedule/paused",
      scope: "settings:write",
      actor,
      json: { extensions },
    });
  }

  /** Whether `perDay` is one platform-wide pool or one budget per extension. */
  setUploadBudgetScope(actor: string, scope: "global" | "extension"): Promise<{ ok: boolean; scope?: string }> {
    return this.request({
      method: "POST",
      path: "/api/v1/admin/upload-schedule/scope",
      scope: "settings:write",
      actor,
      json: { scope },
    });
  }

  webhookVerbosity(actor: string): Promise<{ uploadSuccesses: boolean }> {
    return this.request({
      method: "GET",
      path: "/api/v1/admin/webhook-verbosity",
      scope: "settings:read",
      actor,
    });
  }

  setWebhookVerbosity(actor: string, uploadSuccesses: boolean): Promise<{ ok: boolean; uploadSuccesses: boolean }> {
    return this.request({
      method: "POST",
      path: "/api/v1/admin/webhook-verbosity",
      scope: "settings:write",
      actor,
      json: { uploadSuccesses },
    });
  }

  revokeEnrollToken(actor: string, id: string): Promise<{ ok: boolean }> {
    return this.request({
      method: "POST",
      path: `/api/v1/admin/enroll-tokens/${encodeURIComponent(id)}/revoke`,
      scope: "enroll:write",
      actor,
    });
  }

  /** Retarget which extensions a worker will accept jobs for. */
  setWorkerExtensions(actor: string, workerId: string, extensions: string[]): Promise<{ ok: boolean }> {
    return this.request({
      method: "PUT",
      path: `/api/v1/admin/workers/${encodeURIComponent(workerId)}/extensions`,
      scope: "workers:write",
      actor,
      json: { extensions },
    });
  }

  fetchThrottle(actor: string): Promise<FetchThrottleView> {
    return this.request({
      method: "GET",
      path: "/api/v1/admin/fetch-throttle",
      scope: "settings:read",
      actor,
    });
  }

  setFetchThrottle(actor: string, patch: FetchThrottlePatch): Promise<{ global: FetchThrottleValues }> {
    return this.request({
      method: "POST",
      path: "/api/v1/admin/fetch-throttle",
      scope: "settings:write",
      actor,
      json: patch,
    });
  }

  setFetchThrottleFor(
    actor: string,
    extension: string,
    patch: FetchThrottlePatch,
  ): Promise<{ ok: boolean; extension: string; cleared: boolean; effective: FetchThrottleValues }> {
    return this.request({
      method: "POST",
      path: `/api/v1/admin/fetch-throttle/${encodeURIComponent(extension)}`,
      scope: "settings:write",
      actor,
      json: patch,
    });
  }

  // ---- logs and activity ----

  logs(actor: string, query: LogQuery): Promise<{ logs: LogLine[]; nextBefore: string | null; covers: string[] }> {
    return this.request({
      method: "GET",
      path: "/api/v1/admin/logs",
      scope: "runs:read",
      actor,
      query: {
        limit: query.limit,
        minLevel: query.minLevel,
        service: query.service,
        q: query.q,
        since: query.since,
      },
    });
  }

  logSources(actor: string): Promise<{ services: string[]; components: string[] }> {
    return this.request({
      method: "GET",
      path: "/api/v1/admin/logs/sources",
      scope: "runs:read",
      actor,
    });
  }

  activity(actor: string, query: ActivityQuery): Promise<{ events: ActivityEvent[] }> {
    return this.request({
      method: "GET",
      path: "/api/v1/admin/activity",
      scope: "runs:read",
      actor,
      query: {
        severity: query.severity,
        hours: query.hours,
        extension: query.extension,
        q: query.q,
        limit: query.limit,
      },
    });
  }

  // ---- observability ----

  stats(actor: string): Promise<Stats> {
    return this.request<Stats>({ method: "GET", path: "/api/v1/admin/stats", scope: "stats:read", actor });
  }

  audit(actor: string, limit: number): Promise<{ events: AuditEntry[] }> {
    return this.request({
      method: "GET",
      path: "/api/v1/admin/audit",
      scope: "audit:read",
      actor,
      query: { limit },
    });
  }

  /**
   * Best-effort token introspection.
   *
   * There is no self-describe endpoint today: `/api/v1/admin/tokens/*` manages
   * *other* tokens and is gated on `users:admin` + OWNER, which a bot token can
   * never hold. So a 404 here is the expected answer and means "this deployment
   * cannot describe the token" rather than a failure. The probe stays because
   * the day such an endpoint exists, `/whoami` starts listing real scopes with
   * no change to the bot. A 403 is also treated as "cannot tell"; it still
   * yields the held-scope list via `observedScopes`.
   */
  async tokenSelf(actor: string): Promise<TokenIdentity | null> {
    try {
      return await this.request<TokenIdentity>({
        method: "GET",
        path: "/api/v1/admin/tokens/self",
        scope: "stats:read",
        actor,
      });
    } catch (err) {
      if (err instanceof AdminApiError && [403, 404, 405].includes(err.status)) return null;
      throw err;
    }
  }

  /**
   * Start a reporting pass over what MangaDex holds.
   *
   * Dry run only, and not because the bot is untrusted in general: applying is
   * closed to api tokens at the endpoint (routes/chapters.ts), so a bot token
   * could not write these rows even if this asked it to. Reporting is the
   * useful half here anyway: the answer is a number somebody needs to see
   * before deciding to act on it.
   *
   * The pass runs on the server and this only starts it. It takes minutes --
   * a group walk is ~124 MangaDex requests at the client's rate limit -- which
   * is longer than a Discord interaction may be left unanswered, so the command
   * polls `reconcileStatus` and reports whatever is known when its own clock
   * runs out.
   */
  startChapterReconcile(
    actor: string,
    extensions: string[],
  ): Promise<ChapterReconcileStatus & { started: boolean }> {
    return this.request({
      method: "POST",
      path: "/api/v1/admin/chapters/reconcile",
      scope: "chapters:read",
      actor,
      json: { dryRun: true, extensions },
    });
  }

  /** Where the current or last pass is up to. Cheap: one settings row, no MangaDex. */
  reconcileStatus(actor: string): Promise<ChapterReconcileStatus> {
    return this.request({
      method: "GET",
      path: "/api/v1/admin/chapters/reconcile",
      scope: "chapters:read",
      actor,
    });
  }

  /**
   * Start a duplicate scan: which chapters MangaDex holds twice, per series.
   *
   * Report only, and for the same reason as the reconcile pass above: `apply`
   * is closed to api tokens at the endpoint, so a bot token could not queue the
   * deletions even if this asked it to. Reporting is the half that belongs in
   * chat anyway — "these 14 chapters are duplicated" is the thing somebody
   * needs to see before deciding to run `padmin chapters duplicates --apply`.
   */
  startChapterDuplicates(
    actor: string,
    extensions: string[],
    mangaIds: string[] = [],
  ): Promise<ChapterDuplicateStatus & { started: boolean }> {
    return this.request({
      method: "POST",
      path: "/api/v1/admin/chapters/duplicates",
      scope: "chapters:read",
      actor,
      json: { apply: false, extensions, mangaIds },
    });
  }

  /** Where the current or last duplicate scan is up to. */
  duplicatesStatus(actor: string): Promise<ChapterDuplicateStatus> {
    return this.request({
      method: "GET",
      path: "/api/v1/admin/chapters/duplicates",
      scope: "chapters:read",
      actor,
    });
  }

  /**
   * The titles present in an archive, most-affected first.
   *
   * Read-only and therefore reachable on a `pa_…` token, unlike the re-card it
   * exists to aim: queuing card images is closed to api tokens at the endpoint,
   * so what the bot can usefully do is answer "which title, and how many pages
   * would move?" — the question somebody asks in a channel before going to the
   * dashboard or the CLI to do it.
   */
  archiveSeries(
    actor: string,
    opts: { archive: string; search?: string | undefined; extension?: string | undefined; limit?: number },
  ): Promise<ArchiveSeriesReport> {
    return this.request({
      method: "GET",
      path: "/api/v1/admin/chapters/series",
      scope: "chapters:read",
      actor,
      query: {
        archive: opts.archive,
        search: opts.search,
        extension: opts.extension,
        limit: opts.limit ?? 25,
      },
      // Autocomplete calls this on the keystroke and Discord closes the window
      // at three seconds; a slow answer is worth abandoning, not waiting for.
      timeoutMs: 2500,
    });
  }

  /**
   * Start a run that asks the publisher whether one series is still there.
   *
   * Unlike the re-card, this one the bot can actually do: it creates a run, and
   * run creation is not closed to api tokens — a `pa_…` token with `runs:write`
   * has been able to trigger a whole-catalogue CLEAN through `/run` all along,
   * and this is the same thing narrowed to one title.
   */
  recheckSeries(
    actor: string,
    opts: { mdMangaId: string; extension?: string | undefined; apply: boolean; idempotencyKey?: string },
  ): Promise<SeriesRecheck> {
    return this.request({
      method: "POST",
      path: `/api/v1/admin/chapters/series/${encodeURIComponent(opts.mdMangaId)}/recheck`,
      scope: "runs:write",
      actor,
      json: {
        ...(opts.extension ? { extension: opts.extension } : {}),
        dryRun: !opts.apply,
        confirm: opts.apply,
        ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
      },
    });
  }

  /**
   * The same question over a whole extension: a plain CLEAN run.
   *
   * Kept distinct from `recheckSeries` rather than folded into it with an
   * optional id, because they are not the same size of action. This one can
   * mark every chapter of every series the extension tracks, and a caller that
   * can reach it by leaving a field out is a caller that can reach it by
   * accident.
   */
  recheckExtension(
    actor: string,
    opts: { extension: string; apply: boolean; idempotencyKey?: string },
  ): Promise<SeriesRecheck> {
    return this.request({
      method: "POST",
      path: `/api/v1/admin/chapters/extensions/${encodeURIComponent(opts.extension)}/recheck`,
      scope: "runs:write",
      actor,
      json: {
        dryRun: !opts.apply,
        confirm: opts.apply,
        ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
      },
    });
  }

  // ---- permission tuning ----

  /**
   * What the roles mean on this deployment.
   *
   * Reachable with `users:admin` alone, unlike everything below it — which is
   * the whole reason the bot has a permissions command at all. The writes are
   * OWNER-gated server-side and a `pa_…` token is never OWNER, so they answer
   * 403 unless the bot was (unwisely) given the root ADMIN_TOKEN. That refusal
   * is the honest outcome and the handler renders it rather than hiding the
   * subcommand: "you cannot do this from here" beats a missing feature.
   */
  permissions(actor: string): Promise<PermissionCatalogue> {
    return this.request({
      method: "GET",
      path: "/api/v1/admin/permissions",
      scope: "users:admin",
      actor,
    });
  }

  setRolePermissions(actor: string, role: string, scopes: string[]): Promise<{ role: string; scopes: string[] }> {
    return this.request({
      method: "PUT",
      path: `/api/v1/admin/permissions/roles/${encodeURIComponent(role)}`,
      scope: "users:admin",
      actor,
      json: { scopes },
    });
  }

  resetRolePermissions(actor: string, role: string): Promise<{ role: string; scopes: string[] }> {
    return this.request({
      method: "DELETE",
      path: `/api/v1/admin/permissions/roles/${encodeURIComponent(role)}`,
      scope: "users:admin",
      actor,
    });
  }

  userPermissions(actor: string, userId: string): Promise<UserPermissions> {
    return this.request({
      method: "GET",
      path: `/api/v1/admin/users/${encodeURIComponent(userId)}/permissions`,
      scope: "users:admin",
      actor,
    });
  }

  setUserPermissions(
    actor: string,
    userId: string,
    tuning: { extraScopes: string[]; deniedScopes: string[] },
  ): Promise<{ extraScopes: string[]; deniedScopes: string[]; effective: string[] }> {
    return this.request({
      method: "PUT",
      path: `/api/v1/admin/users/${encodeURIComponent(userId)}/permissions`,
      scope: "users:admin",
      actor,
      json: tuning,
    });
  }

  // ---- pause / resume ----

  pause(actor: string, minutes: number | null): Promise<{ paused: boolean; indefinite: boolean }> {
    return this.request({
      method: "POST",
      path: "/api/v1/admin/pause",
      scope: "settings:write",
      actor,
      json: { minutes },
    });
  }

  resume(actor: string): Promise<{ paused: boolean }> {
    return this.request({
      method: "POST",
      path: "/api/v1/admin/resume",
      scope: "settings:write",
      actor,
      json: {},
    });
  }

  // ---- runs & jobs ----

  triggerRun(
    actor: string,
    opts: { extension: string; kind: RunKind; idempotencyKey?: string },
  ): Promise<TriggerRunResult> {
    return this.request({
      method: "POST",
      path: "/api/v1/admin/runs",
      scope: "runs:write",
      actor,
      json: opts,
      // createRunForExtension does real work (bundle lookup, segmentation).
      timeoutMs: 45_000,
    });
  }

  listRuns(actor: string, opts: { limit: number; extension?: string }): Promise<{ runs: RunSummary[] }> {
    return this.request({
      method: "GET",
      path: "/api/v1/admin/runs",
      scope: "runs:read",
      actor,
      query: { limit: opts.limit, extension: opts.extension },
    });
  }

  getRun(actor: string, id: string): Promise<{ run: RunDetail }> {
    return this.request({
      method: "GET",
      path: `/api/v1/admin/runs/${encodeURIComponent(id)}`,
      scope: "runs:read",
      actor,
    });
  }

  cancelJob(actor: string, id: string): Promise<{ ok: boolean; result: string }> {
    return this.request({
      method: "POST",
      path: `/api/v1/admin/jobs/${encodeURIComponent(id)}/cancel`,
      scope: "runs:write",
      actor,
      json: {},
    });
  }

  retryJob(actor: string, id: string): Promise<{ ok: boolean }> {
    return this.request({
      method: "POST",
      path: `/api/v1/admin/jobs/${encodeURIComponent(id)}/retry`,
      scope: "runs:write",
      actor,
      json: {},
    });
  }

  /**
   * The dead-letter queue. Cleared jobs are hidden by default and counted in
   * `clearedHidden`, on the same terms as `errors` above: the two list the same
   * failures, so an acknowledgement means the same thing in both.
   */
  deadLetter(
    actor: string,
    cleared: ErrorClearedFilter = "without",
  ): Promise<{ jobs: (JobSummary & { cleared?: { at: string; by: string; note: string | null } })[]; clearedHidden: number }> {
    return this.request({
      method: "GET",
      path: "/api/v1/admin/dead-letter",
      scope: "runs:read",
      actor,
      query: { cleared },
    });
  }

  /** Quarantined submissions, cleared ones hidden by default. See `deadLetter`. */
  quarantine(
    actor: string,
    cleared: ErrorClearedFilter = "without",
  ): Promise<{ quarantined: QuarantineEntry[]; clearedHidden: number }> {
    return this.request({
      method: "GET",
      path: "/api/v1/admin/quarantine",
      scope: "runs:read",
      actor,
      query: { cleared },
    });
  }

  // ---- upload-task queues (routes/ops.ts) ----

  uploadTasks(
    actor: string,
    opts: { kind?: UploadTaskKind; state?: UploadTaskState; limit: number },
  ): Promise<{ tasks: UploadTask[]; counts: { kind: string; state: string; count: number }[] }> {
    return this.request({
      method: "GET",
      path: "/api/v1/admin/upload-tasks",
      scope: "runs:read",
      actor,
      query: { kind: opts.kind, state: opts.state, limit: opts.limit },
    });
  }

  retryUploadTask(actor: string, id: string): Promise<{ ok: boolean; state: string }> {
    return this.request({
      method: "POST",
      path: `/api/v1/admin/upload-tasks/${encodeURIComponent(id)}/retry`,
      scope: "runs:write",
      actor,
      json: {},
    });
  }

  cancelUploadTask(actor: string, id: string): Promise<{ ok: boolean; state: string }> {
    return this.request({
      method: "POST",
      path: `/api/v1/admin/upload-tasks/${encodeURIComponent(id)}/cancel`,
      scope: "runs:write",
      actor,
      json: {},
    });
  }

  requeueStaleUploadTasks(actor: string): Promise<{ ok: boolean; requeued: number }> {
    return this.request({
      method: "POST",
      path: "/api/v1/admin/upload-tasks/requeue-stale",
      scope: "runs:write",
      actor,
      json: {},
    });
  }

  // ---- MangaDex session visibility (routes/ops.ts) ----

  mdAuth(actor: string): Promise<MdAuthState> {
    return this.request({
      method: "GET",
      path: "/api/v1/admin/mangadex/auth",
      scope: "settings:write",
      actor,
    });
  }

  clearMdAuth(actor: string): Promise<{ ok: boolean; cleared: boolean }> {
    return this.request({
      method: "POST",
      path: "/api/v1/admin/mangadex/auth/clear",
      scope: "settings:write",
      actor,
      json: {},
    });
  }

  /**
   * The merged failure feed: dead-lettered jobs, failed tasks, quarantines.
   *
   * Acknowledged entries are omitted by default and counted in `clearedHidden`,
   * so a quiet feed can be reported as "nothing outstanding" without implying
   * nothing ever failed.
   */
  errors(
    actor: string,
    limit: number,
    cleared: ErrorClearedFilter = "without",
  ): Promise<{ errors: ErrorEntry[]; clearedHidden: number }> {
    return this.request({
      method: "GET",
      path: "/api/v1/admin/errors",
      scope: "runs:read",
      actor,
      query: { limit, cleared },
    });
  }

  /**
   * Mark failures as read and dealt with, by id (a full id or a leading prefix)
   * or all at once. Hides them from the feed; changes nothing about the rows.
   */
  clearErrors(
    actor: string,
    body: { ids?: string[]; all?: boolean; note?: string },
  ): Promise<{
    ok: boolean;
    cleared: number;
    entries?: { source: string; id: string }[];
    skipped?: { source: string | null; id: string; reason: string }[];
  }> {
    return this.request({
      method: "POST",
      path: "/api/v1/admin/errors/clear",
      scope: "runs:write",
      actor,
      json: body,
    });
  }

  /** Undo clearing: put acknowledged entries back in the feed. */
  restoreErrors(actor: string, body: { ids?: string[]; all?: boolean }): Promise<{ ok: boolean; restored: number }> {
    return this.request({
      method: "POST",
      path: "/api/v1/admin/errors/restore",
      scope: "runs:write",
      actor,
      json: body,
    });
  }

  // ---- extensions ----

  extensions(actor: string): Promise<{ extensions: ExtensionSummary[] }> {
    return this.request({
      method: "GET",
      path: "/api/v1/admin/extensions",
      scope: "extensions:read",
      actor,
    });
  }

  setExtensionEnabled(actor: string, name: string, enabled: boolean): Promise<{ ok: boolean }> {
    return this.request({
      method: "POST",
      path: `/api/v1/admin/extensions/${encodeURIComponent(name)}/${enabled ? "enable" : "disable"}`,
      scope: "extensions:write",
      actor,
      json: {},
    });
  }

  // ---- schedules ----

  schedules(actor: string): Promise<Schedules> {
    return this.request({
      method: "GET",
      path: "/api/v1/admin/schedules",
      scope: "extensions:read",
      actor,
    });
  }

  extensionSchedule(actor: string, name: string): Promise<ExtensionSchedule> {
    return this.request({
      method: "GET",
      path: `/api/v1/admin/schedules/${encodeURIComponent(name)}`,
      scope: "extensions:read",
      actor,
    });
  }

  /** Append a slot. The API seeds the manifest's slots first when there are none. */
  addSchedule(
    actor: string,
    name: string,
    entry: Omit<ScheduleEntry, "id" | "enabled">,
  ): Promise<{ ok: boolean; id: string; created: boolean; seeded: number }> {
    return this.request({
      method: "POST",
      path: `/api/v1/admin/schedules/${encodeURIComponent(name)}`,
      scope: "extensions:write",
      actor,
      json: entry,
    });
  }

  /** Replace the whole schedule with this one slot. */
  setSchedule(
    actor: string,
    name: string,
    entry: Omit<ScheduleEntry, "id" | "enabled">,
  ): Promise<{ ok: boolean; entries: number }> {
    return this.request({
      method: "PUT",
      path: `/api/v1/admin/schedules/${encodeURIComponent(name)}`,
      scope: "extensions:write",
      actor,
      json: entry,
    });
  }

  setScheduleEnabled(
    actor: string,
    name: string,
    id: string,
    enabled: boolean,
  ): Promise<{ ok: boolean; enabled: boolean }> {
    return this.request({
      method: "PATCH",
      path: `/api/v1/admin/schedules/${encodeURIComponent(name)}/${encodeURIComponent(id)}`,
      scope: "extensions:write",
      actor,
      json: { enabled },
    });
  }

  removeScheduleEntry(
    actor: string,
    name: string,
    id: string,
  ): Promise<{ ok: boolean; removed: boolean }> {
    return this.request({
      method: "DELETE",
      path: `/api/v1/admin/schedules/${encodeURIComponent(name)}/${encodeURIComponent(id)}`,
      scope: "extensions:write",
      actor,
    });
  }

  /** Drop every slot; the extension falls back to its manifest schedule. */
  removeSchedule(actor: string, name: string): Promise<{ ok: boolean; removed: boolean }> {
    return this.request({
      method: "DELETE",
      path: `/api/v1/admin/schedules/${encodeURIComponent(name)}`,
      scope: "extensions:write",
      actor,
    });
  }

  // ---- removal mode ----

  getRemovalMode(actor: string): Promise<{ mode: RemovalMode; validModes: readonly string[] }> {
    return this.request({
      method: "GET",
      path: "/api/v1/admin/removal-mode",
      scope: "settings:write",
      actor,
    });
  }

  setRemovalMode(actor: string, mode: RemovalMode): Promise<{ ok: boolean; mode: string }> {
    return this.request({
      method: "POST",
      path: "/api/v1/admin/removal-mode",
      scope: "settings:write",
      actor,
      json: { mode },
    });
  }

  // ---- worker fleet ----

  workers(actor: string): Promise<{ workers: WorkerSummary[] }> {
    return this.request({
      method: "GET",
      path: "/api/v1/admin/workers",
      scope: "workers:read",
      actor,
    });
  }

  workerAction(actor: string, id: string, action: WorkerAction): Promise<{ ok: boolean; status: string }> {
    return this.request({
      method: "POST",
      path: `/api/v1/admin/workers/${encodeURIComponent(id)}/${action}`,
      scope: "workers:write",
      actor,
      json: {},
    });
  }

  createEnrollToken(
    actor: string,
    opts: { trust: "TRUSTED" | "COMMUNITY"; note?: string; ttlHours: number },
  ): Promise<EnrollToken> {
    return this.request({
      method: "POST",
      path: "/api/v1/admin/enroll-tokens",
      scope: "enroll:write",
      actor,
      json: opts,
    });
  }

  // ---- untracked / tracked series ----

  untracked(
    actor: string,
    opts: { state?: UntrackedState; limit: number; extension?: string; q?: string },
  ): Promise<{ untracked: UntrackedEntry[]; total?: number }> {
    return this.request({
      method: "GET",
      path: "/api/v1/admin/untracked",
      scope: "untracked:read",
      actor,
      query: { state: opts.state, limit: opts.limit, extension: opts.extension, q: opts.q },
    });
  }

  /**
   * One queued row, so a search can be run with the name the scraper reported
   * rather than a name retyped from a chat message.
   */
  untrackedRow(actor: string, id: string): Promise<{ untracked: UntrackedEntry }> {
    return this.request({
      method: "GET",
      path: `/api/v1/admin/untracked/${encodeURIComponent(id)}`,
      scope: "untracked:read",
      actor,
    });
  }

  /**
   * Candidate MangaDex titles for a series.
   *
   * Live, so it costs a MangaDex round trip; that is the point. This is the
   * question "is this already on MangaDex", and the only answer worth having
   * is the current one.
   */
  searchMangadex(
    actor: string,
    opts: { q: string; reportedName?: string; limit: number },
  ): Promise<{ results: MdTitleCandidate[] }> {
    return this.request({
      method: "GET",
      path: "/api/v1/admin/mangadex/search",
      scope: "untracked:read",
      actor,
      query: { q: opts.q, reportedName: opts.reportedName, limit: opts.limit },
      // A MangaDex search behind a cold cache is slower than the platform's own
      // reads; the default 20s occasionally clips it.
      timeoutMs: 30_000,
    });
  }

  /**
   * Which extension and series a publisher link is.
   *
   * Answered from the platform's own rows, so it is cheap enough to run on a
   * link somebody just pasted into a channel.
   */
  resolveSource(actor: string, url: string): Promise<SourceResolution> {
    return this.request({
      method: "GET",
      path: "/api/v1/admin/source/resolve",
      scope: "extensions:read",
      actor,
      query: { url },
    });
  }

  /** Map straight from the publisher link and the MangaDex link. */
  mapFromSource(
    actor: string,
    body: { url: string; mdMangaId: string; mangaId?: string; namespace?: string; dryRun?: boolean },
  ): Promise<SourceMapResult> {
    return this.request({
      method: "POST",
      path: "/api/v1/admin/source/map",
      scope: "extensions:write",
      actor,
      json: body,
      // Reads one title from MangaDex before wiring uploads to it.
      timeoutMs: 30_000,
    });
  }

  /**
   * Map a whole paste of `<publisher link> <mangadex link>` lines.
   *
   * Every line is resolved separately, so the answer is per row rather than one
   * verdict for the batch: a paste of twenty can add, repoint, no-op and fail
   * at the same time.
   */
  mapSourceBatch(
    actor: string,
    body: { text: string; dryRun?: boolean },
  ): Promise<SourceBatchReport> {
    return this.request({
      method: "POST",
      path: "/api/v1/admin/source/map/batch",
      scope: "extensions:write",
      actor,
      json: body,
      // Up to 200 links, each resolved against our own rows, plus one MangaDex
      // round trip for the whole batch.
      timeoutMs: 120_000,
    });
  }

  /** Map an untracked row onto a title that already exists. Creates nothing. */
  mapUntracked(actor: string, id: string, mdMangaId: string): Promise<{ ok: boolean; mdMangaId: string }> {
    return this.request({
      method: "POST",
      path: `/api/v1/admin/untracked/${encodeURIComponent(id)}/map`,
      scope: "untracked:write",
      actor,
      json: { mdMangaId },
    });
  }

  /** The official-English-link auto-map pass, on demand. `dryRun` writes nothing. */
  automapUntracked(
    actor: string,
    opts: { dryRun: boolean; limit: number; extension?: string },
  ): Promise<AutomapReport> {
    return this.request({
      method: "POST",
      path: "/api/v1/admin/untracked/automap",
      scope: "untracked:write",
      actor,
      json: {
        dryRun: opts.dryRun,
        limit: opts.limit,
        ...(opts.extension ? { extension: opts.extension } : {}),
      },
      // Reads MangaDex once per row considered, so it scales with `limit`.
      timeoutMs: 120_000,
    });
  }

  approveUntracked(actor: string, id: string): Promise<{ ok: boolean; mdMangaId?: string }> {
    return this.request({
      method: "POST",
      path: `/api/v1/admin/untracked/${encodeURIComponent(id)}/approve`,
      scope: "untracked:write",
      actor,
      json: {},
      // Creates a real MangaDex title synchronously.
      timeoutMs: 60_000,
    });
  }

  skipUntracked(actor: string, id: string): Promise<{ ok: boolean }> {
    return this.request({
      method: "POST",
      path: `/api/v1/admin/untracked/${encodeURIComponent(id)}/skip`,
      scope: "untracked:write",
      actor,
      json: {},
    });
  }

  tracked(
    actor: string,
    extension: string,
    namespace?: string,
  ): Promise<{ tracked: TrackedEntry[]; namespaces?: string[] }> {
    return this.request({
      method: "GET",
      path: `/api/v1/admin/extensions/${encodeURIComponent(extension)}/tracked`,
      scope: "extensions:read",
      actor,
      query: { namespace },
    });
  }

  setTracked(
    actor: string,
    extension: string,
    entry: { mangaId: string; mdMangaId: string; namespace?: string },
  ): Promise<{ ok: boolean }> {
    return this.request({
      method: "PUT",
      path: `/api/v1/admin/extensions/${encodeURIComponent(extension)}/tracked`,
      scope: "extensions:write",
      actor,
      json: entry,
    });
  }

  removeTracked(
    actor: string,
    extension: string,
    mangaId: string,
    namespace?: string,
  ): Promise<{ ok: boolean; removed: boolean }> {
    return this.request({
      method: "DELETE",
      path:
        `/api/v1/admin/extensions/${encodeURIComponent(extension)}` +
        `/tracked/${encodeURIComponent(mangaId)}`,
      scope: "extensions:write",
      actor,
      // Identity is (namespace, mangaId): omitting it targets the flat id
      // space, which for a namespaced extension is a row that does not exist.
      query: { namespace },
    });
  }

  pausedTracked(actor: string, extension: string): Promise<{ paused: TrackedEntry[] }> {
    return this.request({
      method: "GET",
      path: `/api/v1/admin/extensions/${encodeURIComponent(extension)}/tracked/paused`,
      scope: "extensions:read",
      actor,
    });
  }

  pauseTracked(
    actor: string,
    extension: string,
    body: { mangaIds: string[]; days?: number; renew?: boolean; reason?: string; namespace?: string },
  ): Promise<{ ok: boolean; changed: number; notFound: { mangaId: string }[]; recheckAfter: string }> {
    return this.request({
      method: "POST",
      path: `/api/v1/admin/extensions/${encodeURIComponent(extension)}/tracked/pause`,
      scope: "extensions:write",
      actor,
      json: body,
    });
  }

  unpauseTracked(
    actor: string,
    extension: string,
    body: { mangaIds: string[]; namespace?: string },
  ): Promise<{ ok: boolean; changed: number; notFound: { mangaId: string }[] }> {
    return this.request({
      method: "POST",
      path: `/api/v1/admin/extensions/${encodeURIComponent(extension)}/tracked/unpause`,
      scope: "extensions:write",
      actor,
      json: body,
    });
  }
}

/**
 * Pull the `held` array out of a `requireScope` 403 body
 * (`{error: "missing scope: x", held: [...]}`). Absent on any other error.
 */
function extractHeldScopes(body: string): readonly string[] | undefined {
  if (!body) return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && "held" in parsed) {
      const held = (parsed as { held: unknown }).held;
      if (Array.isArray(held) && held.every((s) => typeof s === "string")) return held;
    }
  } catch {
    // Not JSON; nothing to learn.
  }
  return undefined;
}

/** Pull `{error: "..."}` out of an API response body, if that is its shape. */
function extractError(body: string): string | null {
  if (!body) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      const value = (parsed as { error: unknown }).error;
      if (typeof value === "string") return value;
      return JSON.stringify(value);
    }
  } catch {
    // Not JSON; a proxy error page, most likely.
  }
  return body.slice(0, 300);
}
