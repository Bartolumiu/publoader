/**
 * Slash-command definitions and handlers.
 *
 * Handlers are deliberately free of discord.js: they take an `OptionReader` and
 * return a `BotReply` of plain markdown, so the whole command surface is
 * unit-testable against a fake API client (test/unit/botCommands.test.ts) and
 * bot.ts is left with nothing but transport. Command *definitions* do use
 * discord.js builders, because that is the registration payload's schema and
 * duplicating it would only let the two drift.
 *
 * Command parity is tracked in docs/ipc-to-api-mapping.md. Where the platform
 * has no equivalent, the command still exists and explains
 * what to do instead (see RETIRED_COMMANDS): a bot that answers "unknown
 * command" to `/logs` teaches nobody anything.
 */
import {
  SlashCommandBuilder,
  type SlashCommandIntegerOption,
  type SlashCommandOptionsOnlyBuilder,
  type SlashCommandStringOption,
  type SlashCommandSubcommandBuilder,
  type SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";
import { EXTENSION_NAME_RE } from "../contracts/manifest.js";
import type { Logger } from "../logging.js";
import {
  AdminApiError,
  describeApiError,
  type AdminApiClient,
  type ErrorClearedFilter,
  type RemovalMode,
  type RunKind,
  type SourceMatch,
  type SourceResolution,
  type TrackedEntry,
  type UntrackedEntry,
  type UntrackedState,
  type UploadTaskKind,
  type UploadTaskState,
  type WorkerAction,
} from "./apiClient.js";
import type { Sensitivity } from "./authz.js";
import type { BotAuthzView } from "./apiClient.js";
import type { AuthzEntry, AuthzListName } from "../core/store/botAuthz.js";
import { DEFAULT_COOLDOWN_DAYS, MAX_COOLDOWN_DAYS, NAMESPACE_RE } from "../core/store/trackedManga.js";
import { mdTitleUrl, parseMdTitleId } from "../core/md/titleId.js";

/** Discord's hard cap is 2000 characters; leave room for our own framing. */
const DISCORD_BODY_LIMIT = 1900;

/** Reading command arguments, without depending on discord.js in handlers. */
export interface OptionReader {
  subcommand(): string | null;
  string(name: string): string | null;
  integer(name: string): number | null;
  boolean(name: string): boolean | null;
}

export interface BotReply {
  /** Markdown for the channel (or the ephemeral reply). */
  text: string;
  /**
   * Secret material to deliver by DM instead of by channel message. The
   * enrollment token is the only thing that uses this.
   */
  dm?: string;
}

export interface HandlerContext {
  api: AdminApiClient;
  /** `discord:<username>`, forwarded as X-Actor so the audit log names a human. */
  actor: string;
  options: OptionReader;
  log: Logger;
  /** Stable per-invocation id, used as the run idempotency key. */
  interactionId: string;
}

/**
 * One text box in a command's modal.
 *
 * `paragraph` is the reason modals exist here at all: a slash-command option is
 * a single line, so pasting twenty links into one is not possible. Discord caps
 * a paragraph field at 4000 characters, which is roughly forty link pairs.
 */
export interface BotModalField {
  /** Read back with `options.string(name)`, exactly like a slash option. */
  name: string;
  label: string;
  placeholder?: string;
  paragraph?: boolean;
  required?: boolean;
}

/** A command that collects its input in a modal rather than in options. */
export interface BotModalSpec {
  title: string;
  fields: BotModalField[];
}

export interface BotCommand {
  name: string;
  description: string;
  /**
   * Either one sensitivity for the whole command, or one per subcommand. A
   * missing subcommand key is a programming error and is treated as
   * `destructive`: the safe direction to fail.
   */
  sensitivity: Sensitivity | Record<string, Sensitivity>;
  /** Reply visible only to the invoker. Default for anything operational. */
  ephemeral: boolean;
  builder: SlashCommandBuilder | SlashCommandOptionsOnlyBuilder | SlashCommandSubcommandsOnlyBuilder;
  /**
   * Collect this command's input in a modal instead of in slash options.
   *
   * The modal IS the reply to the slash command, so such a command cannot also
   * defer and answer inline; the work happens when the modal is submitted, and
   * `run` is called then with the fields readable as options.
   */
  modal?: BotModalSpec;
  run(ctx: HandlerContext): Promise<BotReply>;
}

export function resolveSensitivity(command: BotCommand, subcommand: string | null): Sensitivity {
  if (typeof command.sensitivity === "string") return command.sensitivity;
  const found = subcommand ? command.sensitivity[subcommand] : undefined;
  return found ?? "destructive";
}

// ---- formatting helpers ----------------------------------------------------

function truncate(text: string, limit = DISCORD_BODY_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 20)}\n… (truncated)`;
}

/**
 * Clip one value inside a line. `truncate` is for whole replies and appends a
 * "(truncated)" note on its own line, which inside a bullet is worse than the
 * ellipsis it replaces.
 */
function short(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function codeBlock(text: string, lang = ""): string {
  const body = truncate(text, DISCORD_BODY_LIMIT - 10);
  return `\`\`\`${lang}\n${body || "(empty)"}\n\`\`\``;
}

function lines(parts: string[]): string {
  return truncate(parts.join("\n"));
}

/** `2026-07-29T15:05`: enough to correlate, short enough for a chat line. */
function shortTime(value: string | null | undefined): string {
  if (!value) return "-";
  return value.slice(0, 16).replace("T", " ");
}

function age(value: string | null | undefined): string {
  if (!value) return "never";
  const ms = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(ms)) return "?";
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

function counts(record: Record<string, number>): string {
  const entries = Object.entries(record).filter(([, n]) => n > 0);
  if (entries.length === 0) return "none";
  return entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([state, n]) => `${state}=${n}`)
    .join(" ");
}

function requireExtensionName(raw: string | null): string {
  const name = (raw ?? "").trim();
  if (!EXTENSION_NAME_RE.test(name)) {
    // Rejecting client-side turns a 400 with a terse "bad name" into an answer
    // that says what a valid name looks like.
    throw new UserError(
      `\`${name || "(empty)"}\` is not a valid extension name. Names are lowercase letters, digits and underscores only.`,
    );
  }
  return name;
}

/**
 * A MangaDex title id, from the autocomplete, a pasted uuid, or a pasted link.
 *
 * The link is the form that actually exists in a Discord channel: someone posts
 * `https://mangadex.org/title/<uuid>/slug`, the next person maps against it,
 * and asking them to edit the middle out of that URL by hand is how the wrong
 * id gets typed. `parseMdTitleId` reads either shape and names what is wrong
 * with anything else, which beats a 404 on a uuid route: when the value came
 * from a chapter link the fix is not "try again", it is "open the series page".
 */
function requireSeriesId(raw: string | null): string {
  const value = (raw ?? "").trim();
  const parsed = parseMdTitleId(value);
  if ("error" in parsed) {
    // The parser's message already quotes what was given and says what is
    // wrong with it; this adds the two ways to give a right one.
    throw new UserError(
      `Not a MangaDex title id: ${parsed.error}.\n` +
        "Start typing the series name and pick it from the suggestions, or paste the series' " +
        "mangadex.org link and the id is read out of it.",
    );
  }
  return parsed.id;
}

/**
 * The catalogue an external id belongs to, as `--namespace` names on the CLI.
 *
 * Optional everywhere: all but one extension has a single flat id space, and
 * omitting the option means that space. Where it matters (viz serves
 * `shonenjump` and `vizmanga`, and `709` is a different series under each) a
 * mapping made without it lands in a catalogue nothing reads.
 */
function optionalCatalogue(options: OptionReader): string | undefined {
  const value = (options.string("catalogue") ?? "").trim().toLowerCase();
  if (!value) return undefined;
  if (!NAMESPACE_RE.test(value)) {
    throw new UserError(
      `\`${value}\` is not a catalogue name. They are lowercase letters, digits, \`-\` and \`_\`, ` +
        "like `shonenjump`. Leave it empty for extensions that have one id space.",
    );
  }
  return value;
}

/** `mangaId`, or `catalogue/mangaId` where one is named. For messages only. */
function qualified(namespace: string | null | undefined, mangaId: string): string {
  return namespace ? `${namespace}/${mangaId}` : mangaId;
}

function requireString(options: OptionReader, name: string): string {
  const value = (options.string(name) ?? "").trim();
  if (!value) throw new UserError(`\`${name}\` is required.`);
  return value;
}

/**
 * A problem with what the user asked for, as opposed to a platform failure.
 * Reported as-is with no stack and no "unexpected error" framing.
 */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}

// ---- status ---------------------------------------------------------------

async function statusReply(ctx: HandlerContext): Promise<BotReply> {
  const stats = await ctx.api.stats(ctx.actor);
  const parts: string[] = [];

  parts.push(stats.paused ? "**Platform: PAUSED** :pause_button:" : "**Platform: running** :green_circle:");
  parts.push(`**Jobs**: ${counts(stats.jobs)}`);

  const depths = stats.uploadTasks ?? [];
  if (depths.length === 0) {
    parts.push("**Upload tasks**: none queued");
  } else {
    const rendered = depths
      .filter((d) => d.count > 0)
      .map((d) => `${d.kind}/${d.state}=${d.count}`)
      .join(" ");
    parts.push(`**Upload tasks**: ${rendered || "none queued"}`);
  }

  parts.push(`**Workers**: ${counts(stats.workers)}`);
  parts.push(
    stats.quarantined > 0
      ? `**Quarantined results**: ${stats.quarantined} :warning: (see \`/quarantine\`)`
      : "**Quarantined results**: 0",
  );

  // The legacy /status also listed workers by name with per-worker queue depth.
  // Stats only carries counts by status, so fetch the fleet too; but a missing
  // workers:read scope must not take the whole status command down with it.
  try {
    const { workers } = await ctx.api.workers(ctx.actor);
    if (workers.length > 0) {
      const fleet = workers
        .slice(0, 10)
        .map((w) => `• \`${w.name}\`: ${w.status}/${w.trust}, heartbeat ${age(w.lastHeartbeatAt)}`);
      if (workers.length > 10) fleet.push(`…and ${workers.length - 10} more`);
      parts.push(`**Fleet**\n${fleet.join("\n")}`);
    }
  } catch (err) {
    if (err instanceof AdminApiError && err.status === 403) {
      parts.push("**Fleet** not shown: the bot's token lacks `workers:read`.");
    } else {
      throw err;
    }
  }

  return { text: lines(parts) };
}

// ---- schedule options and parsing -----------------------------------------

const WEEKDAY_ABBREVIATIONS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const WEEKDAY_FULL = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

/**
 * `mon,wed` / `weekdays` / `weekends` / `0,2` → the Monday=0 weekday set.
 *
 * Names come first in the documentation because 0=Monday is genuinely
 * surprising to anyone who knows JavaScript's 0=Sunday; typing `0` for Sunday
 * and getting Monday is a mistake nothing downstream can catch. Numbers stay
 * legal because the contract has always used them.
 */
function parseWeekdays(raw: string | null): number[] {
  if (!raw) return [];
  const out = new Set<number>();
  for (const token of raw.split(/[,\s]+/).map((t) => t.trim().toLowerCase()).filter(Boolean)) {
    if (token === "daily" || token === "everyday" || token === "every") return [];
    if (token === "weekdays") {
      [0, 1, 2, 3, 4].forEach((d) => out.add(d));
      continue;
    }
    if (token === "weekends") {
      [5, 6].forEach((d) => out.add(d));
      continue;
    }
    const byName = WEEKDAY_FULL.findIndex((name) => token.length >= 3 && name.startsWith(token));
    if (byName >= 0) {
      out.add(byName);
      continue;
    }
    const asNumber = Number(token);
    if (!Number.isInteger(asNumber) || asNumber < 0 || asNumber > 6) {
      throw new UserError(
        `\`${token}\` is not a weekday. Use \`mon\`…\`sun\`, \`weekdays\`, \`weekends\`, or 0-6 with 0 = Monday.`,
      );
    }
    out.add(asNumber);
  }
  return [...out].sort((a, b) => a - b);
}

/** Shared so every schedule subcommand names the extension the same way. */
const extensionOption = (o: SlashCommandStringOption): SlashCommandStringOption =>
  o.setName("extension").setDescription("Extension name.").setRequired(true).setAutocomplete(true);

/**
 * The extension's own id for a series.
 *
 * Autocompleted, which is the whole reason mapping from Discord is bearable:
 * the ids are opaque strings a publisher chose (`comikey` uses slugs, `viz`
 * uses numbers), so without suggestions every mapping starts by going to look
 * one up somewhere else. See `respondWithMangaIds` in bot.ts for what it offers.
 */
const mangaIdOption = (o: SlashCommandStringOption): SlashCommandStringOption =>
  o
    .setName("manga-id")
    .setDescription("The extension's own id for the series; start typing to search.")
    .setRequired(true)
    .setAutocomplete(true);

/**
 * A row in the untracked queue.
 *
 * Autocompleted by series name: the value is a uuid nobody can recognise, and
 * before this the only way to act on a row was to run `/untracked list` and
 * copy one out of the output. The suggestion carries the extension and the
 * scraped name, which is what an operator is actually choosing between.
 */
const untrackedIdOption = (o: SlashCommandStringOption): SlashCommandStringOption =>
  o
    .setName("id")
    .setDescription("The queued series; start typing its name.")
    .setAutocomplete(true);

/**
 * How a link was resolved, in words rather than a code.
 *
 * Said on every answer because the four ways differ in strength: a queue row is
 * this exact page, a measured rule is an inference from where this extension
 * puts its ids. An operator reading a mapping they did not make should be able
 * to weigh it without knowing the vocabulary.
 */
function viaPhrase(via: SourceMatch["via"] | undefined): string {
  switch (via) {
    case "queue":
      return "this exact page is in the untracked queue";
    case "known-id":
      return "the id in that link is one we already hold";
    case "rule":
      return "measured from where this extension puts ids in its own links";
    case "host":
      return "the site is this extension's; the id was given";
    default:
      return "given directly";
  }
}

/** What a resolve-only `/map` answers with. */
function describeResolution(resolution: SourceResolution): string {
  const match = resolution.match;
  if (!match) {
    return lines([
      `:grey_question: **Could not tell what ${short(resolution.url, 80)} is.**`,
      resolution.reason ?? "",
      resolution.candidates.length
        ? `Extensions serving that site: ${resolution.candidates.map((c) => `\`${c}\``).join(", ")}.`
        : "",
    ].filter(Boolean));
  }
  const where = match.mangaId
    ? `\`${match.extension}\`/\`${qualified(match.namespace, match.mangaId)}\``
    : `\`${match.extension}\` (series unknown)`;
  return lines([
    `:mag: **${where}**`,
    match.untracked ? `Queued as **${short(match.untracked.mangaName, 70)}** (${match.untracked.state}).` : "",
    match.tracked
      ? `Already mapped to <${mdTitleUrl(match.tracked.mdMangaId)}> by \`${match.tracked.source}\`. ` +
        "Mapping it again would repoint it."
      : match.mangaId
        ? "Not mapped yet. Add `mangadex:<link>` to map it."
        : "Add `manga-id:` and `mangadex:<link>` to map it.",
    `How: ${viaPhrase(match.via)}.`,
  ].filter(Boolean));
}

/** The name a queued row goes by. `title` is the older spelling of `mangaName`. */
function nameOf(row: UntrackedEntry): string {
  return row.mangaName || row.title || row.mangaId;
}

/**
 * The queued row behind an `id` option.
 *
 * A miss here is someone typing past the suggestions, and both shapes it takes
 * — a value that is not a uuid (400) and a uuid for a row that is gone (404) —
 * have the same fix, so both say it rather than surfacing the status.
 */
async function findUntracked(ctx: HandlerContext, id: string): Promise<UntrackedEntry> {
  try {
    const { untracked } = await ctx.api.untrackedRow(ctx.actor, id);
    return untracked;
  } catch (err) {
    if (err instanceof AdminApiError && (err.status === 404 || err.status === 400)) {
      throw new UserError(
        `\`${id}\` is not a queued series. Start typing the series name and pick it from the ` +
          "suggestions, or find it with `/untracked list`.",
      );
    }
    throw err;
  }
}

/** The catalogue inside an extension, for the few that have more than one. */
const catalogueOption = (o: SlashCommandStringOption): SlashCommandStringOption =>
  o
    .setName("catalogue")
    .setDescription("The extension's catalogue (viz: shonenjump / vizmanga). Omit for a single id space.")
    .setAutocomplete(true);

/** Which row a mutating subcommand acts on, as printed by `/schedule show`. */
const slotNumberOption = (o: SlashCommandIntegerOption): SlashCommandIntegerOption =>
  o
    .setName("slot")
    .setDescription("Which slot, as numbered by /schedule show.")
    .setRequired(true)
    .setMinValue(1);

/** The options `add` and `set` share; declared once so they cannot drift. */
function withSlotOptions(s: SlashCommandSubcommandBuilder): SlashCommandSubcommandBuilder {
  return s
    .addStringOption(extensionOption)
    .addIntegerOption((o) =>
      o.setName("hour").setDescription("Hour, 0-23 UTC.").setRequired(true).setMinValue(0).setMaxValue(23),
    )
    .addIntegerOption((o) =>
      o.setName("minute").setDescription("Minute, 0-59.").setRequired(true).setMinValue(0).setMaxValue(59),
    )
    .addStringOption((o) =>
      o
        .setName("days")
        .setDescription("mon,wed / weekdays / weekends / 0-6 (0=Monday). Omit for every day."),
    )
    .addStringOption((o) =>
      o
        .setName("kind")
        .setDescription("What this slot runs. Default: update.")
        .addChoices(...RUN_KINDS),
    )
    .addStringOption((o) =>
      o
        .setName("label")
        .setDescription('A note for the listing, e.g. "weekly deep clean".')
        .setMaxLength(80),
    );
}

/**
 * Slot number (as printed by `/schedule show`) → the row it names.
 *
 * Re-reads the list rather than trusting a number the operator typed from a
 * message that may be minutes old: the answer names the slot back to them
 * ("Removed 01:00 UTC Wed clean"), so a stale number produces a visibly wrong
 * confirmation rather than a silent deletion of the wrong row.
 */
async function resolveSlot(
  ctx: HandlerContext,
  extension: string,
  index: number | null,
): Promise<{ id: string; hour: number; minute: number; days: number[]; kind: string; label?: string }> {
  if (index === null) throw new UserError("`slot` is required; run `/schedule show` to see the numbers.");
  const { entries } = await ctx.api.extensionSchedule(ctx.actor, extension);
  if (entries.length === 0) {
    throw new UserError(
      `\`${extension}\` has no operator slots to change. It is on its manifest schedule; \`/schedule add\` takes it over.`,
    );
  }
  const slot = entries[index - 1];
  if (!slot || !slot.id) {
    throw new UserError(`\`${extension}\` has ${entries.length} slot(s); \`${index}\` is not one of them.`);
  }
  return { ...slot, id: slot.id };
}

// ---- command table --------------------------------------------------------

const RUN_KINDS: { name: string; value: RunKind }[] = [
  { name: "update (respect the schedule's normal behaviour)", value: "UPDATE" },
  { name: "force (run now regardless of schedule)", value: "FORCE" },
  { name: "clean (destructive: full re-scrape)", value: "CLEAN" },
];

/**
 * How long `/reconcile` will wait for a pass before answering with progress.
 *
 * Discord gives a deferred interaction fifteen minutes, but nobody watches a
 * chat window for that long, and a pass over several groups can exceed it
 * anyway. Half a minute is enough that a small deployment answers with real
 * numbers on the first try, and short enough that a large one does not look
 * hung. Nothing is lost by giving up: the pass runs on the server and the next
 * `/reconcile` finds it.
 */
const RECONCILE_WAIT_MS = 30_000;
const RECONCILE_POLL_MS = 2_000;

/**
 * Wait for a background pass, or return null when it is still going.
 *
 * Returns the report the moment one exists -- including a report from a pass
 * that finished before this command ran, which is what makes "ask again in a
 * minute" work.
 *
 * Generic over the report because the reconcile pass and the duplicate scan
 * publish the same envelope to two endpoints; `poll` is whichever status call
 * belongs to the one being watched.
 */
async function waitForPass<T>(
  started: { state: string; report?: T },
  poll: () => Promise<{ state: string; report?: T }>,
): Promise<T | null> {
  if (started.state === "done" && started.report) return started.report;

  const deadline = Date.now() + RECONCILE_WAIT_MS;
  for (;;) {
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, RECONCILE_POLL_MS));
    const status = await poll();
    if (status.state === "done" && status.report) return status.report;
    if (status.state === "failed" || status.state === "idle") return null;
  }
}

/**
 * The "still working" answer: which steps are behind it, and which one is in
 * flight. One status line was barely better than a spinner, and both passes
 * publish the same step list, so both say it the same way.
 */
function stillWorkingText(
  steps: { label: string; state: string; done: number; total: number | null }[],
  opts: { what: string; alreadyRunning: boolean; command: string },
): string {
  const finished = steps.filter((step) => step.state === "done" || step.state === "skipped");
  const running = steps.find((step) => step.state === "running");
  return (
    `:hourglass: Still ${opts.what}` +
    (opts.alreadyRunning ? " (a pass was already running)" : "") +
    (steps.length > 0 ? `: step ${finished.length + 1} of ${steps.length}` : "") +
    ".\n" +
    (running
      ? `• **${running.label}**` +
        (running.total !== null
          ? ` — ${running.done} of ${running.total}`
          : running.done > 0
            ? ` — ${running.done} so far`
            : "") +
        "\n"
      : "") +
    `It keeps going without me. Run \`${opts.command}\` again in a minute for the numbers.`
  );
}

// ---- /access helpers -------------------------------------------------------

/**
 * The four allowlists, named the way an operator would say them out loud.
 * The stored key is the API's; the choice value is what fits in a slash option.
 */
const LIST_LABELS: Record<AuthzListName, string> = {
  guilds: "guilds",
  channels: "allowed channels",
  adminUsers: "admin users",
  adminRoles: "admin roles",
};

const LIST_CHOICES = [
  { name: "guilds — servers this bot answers in", value: "guilds" },
  { name: "channels — where commands may be used", value: "channels" },
  { name: "admin-users — who may change things", value: "admin-users" },
  { name: "admin-roles — which roles may change things", value: "admin-roles" },
] as const;

const LIST_BY_CHOICE: Record<string, AuthzListName | undefined> = {
  guilds: "guilds",
  channels: "channels",
  "admin-users": "adminUsers",
  "admin-roles": "adminRoles",
};

/**
 * Pull a snowflake out of whatever the operator typed.
 *
 * Accepting `<#123>`, `<@123>` and `<@&123>` matters because a mention is what
 * Discord inserts when you type `#` or `@`, so it is what an operator produces
 * by accident far more often than a bare id. Refusing it would be technically
 * correct and practically hostile.
 */
export function snowflakeFrom(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? "").trim();
  const mention = /^<(?:#|@[!&]?)(\d+)>$/.exec(trimmed);
  const id = mention?.[1] ?? trimmed;
  return /^\d{5,}$/.test(id) ? id : null;
}

/** `#ops (800…001)` when labelled, a bare id when not; `none` for an empty list. */
function renderEntries(entries: readonly AuthzEntry[]): string {
  if (entries.length === 0) return "_none_";
  return entries.map((e) => (e.label ? `${e.label} (\`${e.id}\`)` : `\`${e.id}\``)).join(", ");
}

function describeView(view: BotAuthzView): string {
  const counts = (Object.keys(LIST_LABELS) as AuthzListName[])
    .map((name) => `${view.entries[name].length} ${LIST_LABELS[name]}`)
    .join(", ");
  return counts;
}

const commands: BotCommand[] = [
  {
    name: "status",
    description: "Platform health: pause state, job counts, upload-task depths, worker fleet.",
    sensitivity: "read",
    ephemeral: false,
    builder: new SlashCommandBuilder()
      .setName("status")
      .setDescription("Platform health: pause state, job counts, upload-task depths, worker fleet."),
    run: statusReply,
  },
  {
    // Kept from the legacy bot, where `ping` was an alias for `status`. Here it
    // adds the one thing status cannot show: whether the API is answering, and
    // how fast.
    name: "ping",
    description: "Check that the bot can reach the core API, and how long it takes.",
    sensitivity: "read",
    ephemeral: false,
    builder: new SlashCommandBuilder()
      .setName("ping")
      .setDescription("Check that the bot can reach the core API, and how long it takes."),
    async run(ctx) {
      const started = Date.now();
      const stats = await ctx.api.stats(ctx.actor);
      const elapsed = Date.now() - started;
      return {
        text: `:green_circle: Admin API reachable in **${elapsed}ms** (${ctx.api.baseUrl}). Platform is ${stats.paused ? "**paused**" : "running"}.`,
      };
    },
  },
  {
    name: "stats",
    description: "Alias for /status, kept from the legacy bot.",
    sensitivity: "read",
    ephemeral: false,
    builder: new SlashCommandBuilder()
      .setName("stats")
      .setDescription("Alias for /status, kept from the legacy bot."),
    run: statusReply,
  },
  {
    name: "run",
    description: "Trigger a run for one extension.",
    sensitivity: "mutate",
    ephemeral: false,
    builder: new SlashCommandBuilder()
      .setName("run")
      .setDescription("Trigger a run for one extension.")
      .addStringOption((o) =>
        o.setName("extension").setDescription("Published extension name.").setRequired(true).setAutocomplete(true),
      )
      .addStringOption((o) =>
        o
          .setName("mode")
          .setDescription("update (default), force, or clean.")
          .addChoices(...RUN_KINDS.map((k) => ({ name: k.name, value: k.value }))),
      )
      .addBooleanOption((o) =>
        o.setName("confirm").setDescription("Required for mode:clean; confirms a destructive re-scrape."),
      ),
    async run(ctx) {
      const extension = requireExtensionName(ctx.options.string("extension"));
      const kind = (ctx.options.string("mode") ?? "UPDATE") as RunKind;
      if (kind === "CLEAN" && ctx.options.boolean("confirm") !== true) {
        return {
          text:
            `:warning: **\`${extension}\` clean run not started.** A CLEAN run re-scrapes the extension from scratch ` +
            "and can republish a large amount of content.\nRe-issue with `confirm: true` if that is what you want.",
        };
      }
      // One key per interaction: Discord retries and fat-fingered double-submits
      // then collapse into the same run instead of creating two.
      const result = await ctx.api.triggerRun(ctx.actor, {
        extension,
        kind,
        idempotencyKey: `discord:${ctx.interactionId}`,
      });
      return {
        text: result.created
          ? `:rocket: Started **${kind}** run for \`${extension}\`: run \`${result.runId}\`. Follow it with \`/runs show id:${result.runId}\`.`
          : `:information_source: A run for that exact request already existed: \`${result.runId}\` (nothing new was created).`,
      };
    },
  },
  {
    name: "pause",
    description: "Pause scheduling and job dispatch platform-wide.",
    sensitivity: "mutate",
    ephemeral: false,
    builder: new SlashCommandBuilder()
      .setName("pause")
      .setDescription("Pause scheduling and job dispatch platform-wide.")
      .addIntegerOption((o) =>
        o
          .setName("minutes")
          .setDescription("How long to pause. Omit to pause indefinitely until /resume.")
          .setMinValue(1)
          .setMaxValue(1440),
      ),
    async run(ctx) {
      const minutes = ctx.options.integer("minutes");
      const result = await ctx.api.pause(ctx.actor, minutes ?? null);
      return {
        text: result.indefinite
          ? ":pause_button: Platform paused **indefinitely**. Use `/resume` to release it."
          : `:pause_button: Platform paused for **${minutes} minute(s)**.`,
      };
    },
  },
  {
    name: "resume",
    description: "Release a pause immediately.",
    sensitivity: "mutate",
    ephemeral: false,
    builder: new SlashCommandBuilder().setName("resume").setDescription("Release a pause immediately."),
    async run(ctx) {
      await ctx.api.resume(ctx.actor);
      return { text: ":green_circle: Platform resumed." };
    },
  },
  {
    name: "extensions",
    description: "List published extensions, or enable/disable one.",
    sensitivity: { list: "read", enable: "mutate", disable: "mutate" },
    ephemeral: true,
    builder: new SlashCommandBuilder()
      .setName("extensions")
      .setDescription("List published extensions, or enable/disable one.")
      .addSubcommand((s) => s.setName("list").setDescription("Published bundles, versions and disabled state."))
      .addSubcommand((s) =>
        s
          .setName("enable")
          .setDescription("Re-enable a disabled extension.")
          .addStringOption((o) =>
            o.setName("extension").setDescription("Extension name.").setRequired(true).setAutocomplete(true),
          ),
      )
      .addSubcommand((s) =>
        s
          .setName("disable")
          .setDescription("Stop scheduling an extension.")
          .addStringOption((o) =>
            o.setName("extension").setDescription("Extension name.").setRequired(true).setAutocomplete(true),
          ),
      ),
    async run(ctx) {
      const sub = ctx.options.subcommand();
      if (sub === "list") {
        const { extensions } = await ctx.api.extensions(ctx.actor);
        if (extensions.length === 0) {
          return {
            text: "No bundles published yet. `/extensions list` shows *published bundles*, not files on disk; publish with `publoader-admin bundle publish <dir>`.",
          };
        }
        const rendered = extensions
          .map(
            (e) =>
              `${e.disabled ? ":no_entry:" : ":green_circle:"} \`${e.name}\` v${e.version} ` +
              `(${e.sha256.slice(0, 12)}) published ${shortTime(e.publishedAt)}`,
          )
          .join("\n");
        return { text: lines([`**${extensions.length} published extension(s)**`, rendered]) };
      }
      const extension = requireExtensionName(ctx.options.string("extension"));
      const enable = sub === "enable";
      await ctx.api.setExtensionEnabled(ctx.actor, extension, enable);
      return {
        text: enable
          ? `:green_circle: \`${extension}\` enabled; it will be scheduled again.`
          : `:no_entry: \`${extension}\` disabled. Scheduled runs will skip it; in-flight jobs are unaffected.`,
      };
    },
  },
  {
    name: "schedule",
    description: "Inspect or override extension run schedules.",
    sensitivity: {
      list: "read",
      show: "read",
      add: "mutate",
      set: "mutate",
      enable: "mutate",
      disable: "mutate",
      remove: "mutate",
      reset: "mutate",
    },
    ephemeral: true,
    builder: new SlashCommandBuilder()
      .setName("schedule")
      .setDescription("Inspect or override extension run schedules.")
      .addSubcommand((s) => s.setName("list").setDescription("Every extension's slots and where they come from."))
      .addSubcommand((s) =>
        s
          .setName("show")
          .setDescription("One extension's slots, numbered for the other subcommands.")
          .addStringOption(extensionOption),
      )
      .addSubcommand((s) =>
        withSlotOptions(
          s.setName("add").setDescription("Add a slot, keeping the ones already there (UTC)."),
        ),
      )
      .addSubcommand((s) =>
        withSlotOptions(
          s.setName("set").setDescription("REPLACE the whole schedule with this single slot (UTC)."),
        ),
      )
      .addSubcommand((s) =>
        s
          .setName("disable")
          .setDescription("Stop one slot firing, keeping it in the list.")
          .addStringOption(extensionOption)
          .addIntegerOption(slotNumberOption),
      )
      .addSubcommand((s) =>
        s
          .setName("enable")
          .setDescription("Switch a slot back on.")
          .addStringOption(extensionOption)
          .addIntegerOption(slotNumberOption),
      )
      .addSubcommand((s) =>
        s
          .setName("remove")
          .setDescription("Delete one slot.")
          .addStringOption(extensionOption)
          .addIntegerOption(slotNumberOption),
      )
      .addSubcommand((s) =>
        s
          .setName("reset")
          .setDescription("Drop every operator slot and fall back to the manifest schedule.")
          .addStringOption(extensionOption),
      ),
    async run(ctx) {
      const sub = ctx.options.subcommand();
      if (sub === "list") {
        const { defaults, overrides } = await ctx.api.schedules(ctx.actor);
        const names = [...new Set([...Object.keys(defaults), ...Object.keys(overrides)])].sort();
        if (names.length === 0) return { text: "No schedules configured." };
        const rendered = names.map((name) => {
          const slots = overrides[name] ?? defaults[name] ?? [];
          const source = overrides[name] ? "override" : "manifest default";
          if (slots.length === 0) return `• \`${name}\`, nothing scheduled *(${source})*`;
          return `• \`${name}\` *(${source})*: ${slots.map(formatSchedule).join(" · ")}`;
        });
        return {
          text: lines([
            "**Schedules** (UTC). Changes take effect within one scheduler tick.",
            ...rendered,
          ]),
        };
      }

      const extension = requireExtensionName(ctx.options.string("extension"));

      if (sub === "show") {
        const res = await ctx.api.extensionSchedule(ctx.actor, extension);
        const body =
          res.entries.length > 0
            ? res.entries.map((slot, index) => `\`${index + 1}.\` ${formatSchedule(slot)}`)
            : ["*No operator slots. The manifest schedule below is what runs.*"];
        return {
          text: lines([
            `**\`${extension}\`**: ${res.source === "operator" ? "operator slots" : "manifest schedule"} (UTC)`,
            ...body,
            `Manifest: ${res.manifest.map(formatSchedule).join(" · ") || "none"}`,
          ]),
        };
      }

      if (sub === "reset") {
        const result = await ctx.api.removeSchedule(ctx.actor, extension);
        return {
          text: result.removed
            ? `:wastebasket: All operator slots removed for \`${extension}\`: it falls back to its manifest schedule.`
            : `\`${extension}\` had no operator slots; nothing changed.`,
        };
      }

      if (sub === "remove" || sub === "enable" || sub === "disable") {
        // Slots are addressed by their position in `/schedule show`, not by
        // their uuid. Discord has no way to paste one that is not "read it off
        // another message and hope"; a number the operator just looked at is
        // the identifier they actually have.
        const slot = await resolveSlot(ctx, extension, ctx.options.integer("slot"));
        if (sub === "remove") {
          await ctx.api.removeScheduleEntry(ctx.actor, extension, slot.id);
          return { text: `:wastebasket: Removed ${formatSchedule(slot)} from \`${extension}\`.` };
        }
        const enabled = sub === "enable";
        await ctx.api.setScheduleEnabled(ctx.actor, extension, slot.id, enabled);
        return {
          text: enabled
            ? `:green_circle: ${formatSchedule(slot)} is on again for \`${extension}\`.`
            : `:no_entry: ${formatSchedule(slot)} is switched off for \`${extension}\`; the row is kept.`,
        };
      }

      const hour = ctx.options.integer("hour");
      const minute = ctx.options.integer("minute");
      if (hour === null || minute === null) throw new UserError("`hour` and `minute` are required.");
      const entry = {
        hour,
        minute,
        days: parseWeekdays(ctx.options.string("days")),
        kind: (ctx.options.string("kind") ?? "UPDATE") as "UPDATE" | "CLEAN" | "FORCE",
        ...(ctx.options.string("label") ? { label: ctx.options.string("label") as string } : {}),
      };

      if (sub === "add") {
        const res = await ctx.api.addSchedule(ctx.actor, extension, entry);
        const seeded =
          res.seeded > 0
            ? ` Its ${res.seeded} manifest slot(s) were copied in first, so they keep running.`
            : "";
        return {
          text: res.created
            ? `:calendar: \`${extension}\` also runs ${formatSchedule(entry)}.${seeded} Takes effect within one scheduler tick.`
            : `\`${extension}\` already had ${formatSchedule(entry)}; nothing changed.${seeded}`,
        };
      }

      await ctx.api.setSchedule(ctx.actor, extension, entry);
      return {
        text:
          `:calendar: \`${extension}\` now runs **only** ${formatSchedule(entry)}; every other slot was removed. ` +
          "Use `/schedule add` to keep the others. Takes effect within one scheduler tick.",
      };
    },
  },
  {
    name: "removal-mode",
    description: "Show or set how expired chapters are removed.",
    sensitivity: { get: "read", set: "mutate" },
    ephemeral: true,
    builder: new SlashCommandBuilder()
      .setName("removal-mode")
      .setDescription("Show or set how expired chapters are removed.")
      .addSubcommand((s) => s.setName("get").setDescription("Current global removal mode."))
      .addSubcommand((s) =>
        s
          .setName("set")
          .setDescription("Set the global removal mode.")
          .addStringOption((o) =>
            o
              .setName("mode")
              .setDescription("unavailable keeps the chapter card; delete removes it.")
              .setRequired(true)
              .addChoices({ name: "unavailable", value: "unavailable" }, { name: "delete", value: "delete" }),
          ),
      ),
    async run(ctx) {
      if (ctx.options.subcommand() === "get") {
        const { mode, validModes } = await ctx.api.getRemovalMode(ctx.actor);
        return { text: `Chapter-removal mode is **${mode}** (valid: ${validModes.join(", ")}).` };
      }
      const mode = requireString(ctx.options, "mode") as RemovalMode;
      const result = await ctx.api.setRemovalMode(ctx.actor, mode);
      return {
        text: `Chapter-removal mode set to **${result.mode}**. Extensions that force a mode in their manifest still win.`,
      };
    },
  },
  {
    name: "runs",
    description: "Recent runs, or one run in detail.",
    sensitivity: "read",
    ephemeral: true,
    builder: new SlashCommandBuilder()
      .setName("runs")
      .setDescription("Recent runs, or one run in detail.")
      .addSubcommand((s) =>
        s
          .setName("recent")
          .setDescription("Recent runs, newest first.")
          .addStringOption((o) =>
            o.setName("extension").setDescription("Filter to one extension.").setAutocomplete(true),
          )
          .addIntegerOption((o) =>
            o.setName("limit").setDescription("How many (1-50, default 15).").setMinValue(1).setMaxValue(50),
          ),
      )
      .addSubcommand((s) =>
        s
          .setName("show")
          .setDescription("One run with every job, attempt count and error.")
          .addStringOption((o) => o.setName("id").setDescription("Run id.").setRequired(true)),
      ),
    async run(ctx) {
      if (ctx.options.subcommand() === "recent") {
        const extension = ctx.options.string("extension");
        const { runs } = await ctx.api.listRuns(ctx.actor, {
          limit: ctx.options.integer("limit") ?? 15,
          ...(extension ? { extension: requireExtensionName(extension) } : {}),
        });
        if (runs.length === 0) return { text: "No runs recorded." };
        const rendered = runs.map(
          (r) =>
            `${runIcon(r.state)} \`${r.id.slice(0, 8)}\` **${r.extension}** [${r.kind}] ${r.state} ` +
            `: ${shortTime(r.createdAt)} by ${r.triggeredBy ?? "schedule"}`,
        );
        return { text: lines([`**${runs.length} recent run(s)**`, ...rendered]) };
      }
      const { run } = await ctx.api.getRun(ctx.actor, requireString(ctx.options, "id"));
      const header = [
        `${runIcon(run.state)} **${run.extension}** [${run.kind}]; **${run.state}**`,
        `run \`${run.id}\``,
        `created ${shortTime(run.createdAt)}, finished ${shortTime(run.finishedAt)}`,
        `triggered by ${run.triggeredBy ?? "schedule"}`,
      ];
      const jobs = run.jobs ?? [];
      const jobLines = jobs.slice(0, 15).map((j) => {
        const segment =
          j.segmentIndex === null || j.segmentIndex === undefined
            ? ""
            : ` seg ${j.segmentIndex + 1}/${j.segmentTotal ?? "?"}`;
        const error = j.lastError ? `: \`${j.lastError.slice(0, 120)}\`` : "";
        return `• \`${j.id.slice(0, 8)}\`${segment} ${j.state} attempt ${j.attempt}${error}`;
      });
      if (jobs.length > 15) jobLines.push(`…and ${jobs.length - 15} more job(s)`);
      return {
        text: lines([...header, `**${jobs.length} job(s)**`, ...jobLines]),
      };
    },
  },
  {
    name: "jobs",
    description: "Cancel a job, or replay a dead-lettered one.",
    sensitivity: { cancel: "mutate", retry: "mutate" },
    ephemeral: true,
    builder: new SlashCommandBuilder()
      .setName("jobs")
      .setDescription("Cancel a job, or replay a dead-lettered one.")
      .addSubcommand((s) =>
        s
          .setName("cancel")
          .setDescription("Cancel one job.")
          .addStringOption((o) => o.setName("id").setDescription("Job id.").setRequired(true)),
      )
      .addSubcommand((s) =>
        s
          .setName("retry")
          .setDescription("Replay a dead-lettered job.")
          .addStringOption((o) => o.setName("id").setDescription("Job id.").setRequired(true)),
      ),
    async run(ctx) {
      const id = requireString(ctx.options, "id");
      if (ctx.options.subcommand() === "cancel") {
        const result = await ctx.api.cancelJob(ctx.actor, id);
        return { text: `:octagonal_sign: Job \`${id}\` cancel → **${result.result}**.` };
      }
      await ctx.api.retryJob(ctx.actor, id);
      return { text: `:arrows_counterclockwise: Job \`${id}\` requeued from the dead-letter queue.` };
    },
  },
  {
    name: "dead-letter",
    description: "Jobs that exhausted retries or hit a permanent error.",
    sensitivity: "read",
    ephemeral: true,
    builder: new SlashCommandBuilder()
      .setName("dead-letter")
      .setDescription("Jobs that exhausted retries or hit a permanent error."),
    async run(ctx) {
      const { jobs } = await ctx.api.deadLetter(ctx.actor);
      if (jobs.length === 0) return { text: ":green_circle: Dead-letter queue is empty." };
      const rendered = jobs
        .slice(0, 15)
        .map(
          (j) =>
            `• \`${j.id.slice(0, 8)}\` ${j.extension ?? "?"} attempt ${j.attempt} ${shortTime(j.updatedAt)}` +
            (j.lastError ? `\n   \`${j.lastError.slice(0, 160)}\`` : ""),
        );
      if (jobs.length > 15) rendered.push(`…and ${jobs.length - 15} more`);
      return {
        text: lines([
          `**${jobs.length} dead-lettered job(s)**: replay one with \`/jobs retry id:<id>\``,
          ...rendered,
        ]),
      };
    },
  },
  {
    name: "quarantine",
    description: "Result envelopes rejected by schema or policy validation.",
    sensitivity: "read",
    ephemeral: true,
    builder: new SlashCommandBuilder()
      .setName("quarantine")
      .setDescription("Result envelopes rejected by schema or policy validation."),
    async run(ctx) {
      const { quarantined } = await ctx.api.quarantine(ctx.actor);
      if (quarantined.length === 0) return { text: ":green_circle: Nothing quarantined." };
      const rendered = quarantined
        .slice(0, 15)
        .map(
          (q) =>
            `• job \`${q.jobId.slice(0, 8)}\` worker \`${q.workerName ?? (q.workerId ?? "?").slice(0, 8)}\` ` +
            `${shortTime(q.createdAt)}; \`${(q.rejectReason ?? "no reason recorded").slice(0, 140)}\``,
        );
      if (quarantined.length > 15) rendered.push(`…and ${quarantined.length - 15} more`);
      return {
        text: lines([
          `:warning: **${quarantined.length} quarantined submission(s)**: a worker submitting these repeatedly should be drained.`,
          ...rendered,
        ]),
      };
    },
  },
  {
    // The legacy `queue peek` / `queue clear` pair, restored now that
    // routes/ops.ts exposes upload tasks. `clear` is deliberately not restored:
    // one Discord message could empty a queue of thousands of pending uploads,
    // so cancellation is per task.
    name: "queue",
    description: "The uploader's task queue: inspect, retry, cancel, unstick.",
    sensitivity: { list: "read", retry: "mutate", cancel: "destructive", "requeue-stale": "mutate" },
    ephemeral: true,
    builder: new SlashCommandBuilder()
      .setName("queue")
      .setDescription("The uploader's task queue: inspect, retry, cancel, unstick.")
      .addSubcommand((s) =>
        s
          .setName("list")
          .setDescription("Upload tasks, newest first, with depth totals.")
          .addStringOption((o) =>
            o
              .setName("kind")
              .setDescription("Filter by task kind.")
              .addChoices(
                { name: "UPLOAD", value: "UPLOAD" },
                { name: "EDIT", value: "EDIT" },
                { name: "DELETE", value: "DELETE" },
                { name: "UNAVAILABLE", value: "UNAVAILABLE" },
              ),
          )
          .addStringOption((o) =>
            o
              .setName("state")
              .setDescription("Filter by state.")
              .addChoices(
                { name: "PENDING", value: "PENDING" },
                { name: "LEASED", value: "LEASED" },
                { name: "DONE", value: "DONE" },
                { name: "FAILED", value: "FAILED" },
                { name: "DEAD_LETTER", value: "DEAD_LETTER" },
              ),
          )
          .addIntegerOption((o) =>
            o.setName("limit").setDescription("How many rows (1-50, default 15).").setMinValue(1).setMaxValue(50),
          ),
      )
      .addSubcommand((s) =>
        s
          .setName("retry")
          .setDescription("Requeue a FAILED or DEAD_LETTER task with a fresh attempt budget.")
          .addStringOption((o) => o.setName("id").setDescription("Upload-task id.").setRequired(true)),
      )
      .addSubcommand((s) =>
        s
          .setName("cancel")
          .setDescription("Abandon a task without ever sending it to MangaDex.")
          .addStringOption((o) => o.setName("id").setDescription("Upload-task id.").setRequired(true))
          .addBooleanOption((o) =>
            o.setName("confirm").setDescription("Required: the chapter will never be uploaded."),
          ),
      )
      .addSubcommand((s) =>
        s
          .setName("requeue-stale")
          .setDescription("Sweep leases held by a dead uploader back onto the queue."),
      ),
    async run(ctx) {
      const sub = ctx.options.subcommand();
      if (sub === "list") {
        const kind = ctx.options.string("kind");
        const state = ctx.options.string("state");
        const { tasks, counts } = await ctx.api.uploadTasks(ctx.actor, {
          limit: ctx.options.integer("limit") ?? 15,
          ...(kind ? { kind: kind as UploadTaskKind } : {}),
          ...(state ? { state: state as UploadTaskState } : {}),
        });
        const depths = (counts ?? [])
          .filter((c) => c.count > 0)
          .map((c) => `${c.kind}/${c.state}=${c.count}`)
          .join(" ");
        if (tasks.length === 0) {
          return { text: `No matching upload tasks.\n**Queue depths**: ${depths || "empty"}` };
        }
        const rendered = tasks.map(
          (t) =>
            `• \`${t.id.slice(0, 8)}\` ${t.kind}/${t.state} attempt ${t.attempt}/${t.maxAttempts} ` +
            `${shortTime(t.updatedAt)}` +
            (t.lastError ? `\n   \`${t.lastError.slice(0, 140)}\`` : ""),
        );
        return {
          text: lines([
            `**Queue depths**: ${depths || "empty"}`,
            `**${tasks.length} task(s)**: ids are truncated above; use \`/queue list\` output with the full id from the dashboard for retry/cancel.`,
            ...rendered,
          ]),
        };
      }
      if (sub === "requeue-stale") {
        const result = await ctx.api.requeueStaleUploadTasks(ctx.actor);
        return {
          text:
            result.requeued > 0
              ? `:arrows_counterclockwise: Requeued **${result.requeued}** stale upload task(s).`
              : "Nothing to requeue; no upload task is holding an expired lease.",
        };
      }
      const id = requireString(ctx.options, "id");
      if (sub === "retry") {
        await ctx.api.retryUploadTask(ctx.actor, id);
        return { text: `:arrows_counterclockwise: Upload task \`${id}\` requeued with a fresh attempt budget.` };
      }
      if (ctx.options.boolean("confirm") !== true) {
        return {
          text:
            `:warning: **Upload task \`${id}\` not cancelled.** Cancelling means this chapter is never sent to ` +
            "MangaDex; the task leaves the queue marked DONE with a note saying an operator abandoned it.\n" +
            "Re-issue with `confirm: true` if that is what you want.",
        };
      }
      await ctx.api.cancelUploadTask(ctx.actor, id);
      return { text: `:octagonal_sign: Upload task \`${id}\` abandoned; it was never sent to MangaDex.` };
    },
  },
  {
    // Legacy `mdauth` / `logout`, restored via routes/ops.ts. There is still no
    // "log in now" command: clearing the saved session makes the next MangaDex
    // call re-authenticate, which is the same outcome by a safer route.
    name: "mdauth",
    description: "MangaDex session state, and forgetting a bad one.",
    sensitivity: { status: "read", clear: "destructive" },
    ephemeral: true,
    builder: new SlashCommandBuilder()
      .setName("mdauth")
      .setDescription("MangaDex session state, and forgetting a bad one.")
      .addSubcommand((s) =>
        s.setName("status").setDescription("Whether a MangaDex session is stored, and when it expires."),
      )
      .addSubcommand((s) =>
        s
          .setName("clear")
          .setDescription("Forget the stored session so the next call re-authenticates.")
          .addBooleanOption((o) =>
            o.setName("confirm").setDescription("Required: in-flight uploads may fail while it re-authenticates."),
          ),
      ),
    async run(ctx) {
      if (ctx.options.subcommand() === "status") {
        const auth = await ctx.api.mdAuth(ctx.actor);
        if (!auth.hasAccess && !auth.hasRefresh) {
          return {
            text: ":warning: No MangaDex session is stored. The next upload will authenticate from the configured credentials.",
          };
        }
        const expiry =
          auth.expiresAt === null
            ? "expiry unknown (the stored token could not be parsed, which does not mean it is bad)"
            : auth.expired
              ? `**expired** at ${shortTime(auth.expiresAt)}`
              : `expires ${shortTime(auth.expiresAt)} (in ~${Math.round((auth.expiresInSeconds ?? 0) / 60)} min)`;
        return {
          text: lines([
            `${auth.expired ? ":red_circle:" : ":green_circle:"} **MangaDex session**: access token ${auth.hasAccess ? "stored" : "missing"}, refresh token ${auth.hasRefresh ? "stored" : "missing"}`,
            `Access ${expiry}.`,
            "An expired access token is normal; it is refreshed on demand. Only clear the session if refreshing keeps failing.",
          ]),
        };
      }
      if (ctx.options.boolean("confirm") !== true) {
        return {
          text:
            ":warning: **MangaDex session not cleared.** Clearing forces a fresh login on the next call; an upload " +
            "in flight at that moment can fail and be retried.\nRe-issue with `confirm: true` if refreshing is broken.\n" +
            "This does *not* revoke anything on MangaDex's side; that is a credential rotation (`docs/operations.md`).",
        };
      }
      await ctx.api.clearMdAuth(ctx.actor);
      return {
        text: ":wastebasket: Stored MangaDex session cleared. The next MangaDex call will authenticate from the configured credentials.",
      };
    },
  },
  {
    // The closest thing to legacy `logs`: everything that failed, in one list,
    // without needing a shell on the core host.
    //
    // `clear` is what makes the list usable from Discord over time. Without it
    // the same handled failure is at the top of every `/errors` for weeks and
    // people stop reading it; with it, `/errors` answers "what still needs me?".
    // Clearing hides an entry and nothing more; the rows are untouched, a repeat
    // failure comes back on its own, and `restore` is a full undo.
    name: "errors",
    description: "Recent failures, and clearing the ones you have dealt with.",
    sensitivity: { list: "read", clear: "mutate", restore: "mutate" },
    ephemeral: true,
    builder: new SlashCommandBuilder()
      .setName("errors")
      .setDescription("Recent failures, and clearing the ones you have dealt with.")
      .addSubcommand((s) =>
        s
          .setName("list")
          .setDescription("Dead-lettered jobs, failed uploads and quarantines, newest first.")
          .addIntegerOption((o) =>
            o.setName("limit").setDescription("How many entries (1-30, default 10).").setMinValue(1).setMaxValue(30),
          )
          .addStringOption((o) =>
            o
              .setName("show")
              .setDescription("Which entries to list (default: outstanding only).")
              .addChoices(
                { name: "outstanding only", value: "without" },
                { name: "outstanding and cleared", value: "with" },
                { name: "cleared only", value: "only" },
              ),
          ),
      )
      .addSubcommand((s) =>
        s
          .setName("clear")
          .setDescription("Mark failures as read and dealt with, so they leave the list.")
          .addStringOption((o) =>
            o.setName("id").setDescription("Entry id, or the first few characters of one."),
          )
          .addBooleanOption((o) => o.setName("all").setDescription("Clear every outstanding failure."))
          .addStringOption((o) =>
            o.setName("note").setDescription("Why it is fine; shown to whoever reviews cleared entries."),
          ),
      )
      .addSubcommand((s) =>
        s
          .setName("restore")
          .setDescription("Put cleared entries back in the list.")
          .addStringOption((o) =>
            o.setName("id").setDescription("Entry id, or the first few characters of one."),
          )
          .addBooleanOption((o) => o.setName("all").setDescription("Restore everything that was cleared.")),
      ),
    async run(ctx) {
      const sub = ctx.options.subcommand();

      if (sub === "clear" || sub === "restore") {
        const id = ctx.options.string("id")?.trim() || null;
        const all = ctx.options.boolean("all") === true;
        // Requiring exactly one is the point: `id` with `all` reads as "clear
        // this one" but would clear everything, and neither reads as a no-op.
        if (id && all) throw new UserError("Pass `id` or `all`, not both.");
        if (!id && !all) throw new UserError("Pass an `id` (full or a leading prefix), or `all: true`.");

        if (sub === "restore") {
          const { restored } = await ctx.api.restoreErrors(ctx.actor, all ? { all: true } : { ids: [id!] });
          if (restored === 0) return { text: ":person_shrugging: Nothing matched; nothing was cleared under that id." };
          return {
            text: `:leftwards_arrow_with_hook: ${restored} entr${restored === 1 ? "y" : "ies"} back in \`/errors list\`.`,
          };
        }

        const note = ctx.options.string("note")?.trim() || undefined;
        const result = await ctx.api.clearErrors(ctx.actor, {
          ...(all ? { all: true } : { ids: [id!] }),
          ...(note ? { note } : {}),
        });
        const skipped = (result.skipped ?? []).map((s) => `• \`${s.id.slice(0, 12)}\`: ${s.reason}`);
        if (result.cleared === 0) {
          return { text: lines([":person_shrugging: Nothing was cleared.", ...skipped]) };
        }
        return {
          text: lines([
            `:white_check_mark: ${result.cleared} failure(s) cleared. They are hidden from \`/errors list\`; ` +
              "the jobs, tasks and submissions are unchanged, and anything that fails again comes back.",
            ...skipped,
          ]),
        };
      }

      const show = ctx.options.string("show");
      const cleared: ErrorClearedFilter = show === "with" || show === "only" ? show : "without";
      const { errors, clearedHidden } = await ctx.api.errors(
        ctx.actor,
        ctx.options.integer("limit") ?? 10,
        cleared,
      );

      if (errors.length === 0) {
        if (cleared === "only") return { text: ":person_shrugging: Nothing has been cleared." };
        // "Nothing outstanding" and "nothing ever failed" are different answers
        // and an operator deciding whether to dig further needs the difference.
        return {
          text:
            clearedHidden > 0
              ? `:green_circle: Nothing outstanding. ${clearedHidden} cleared entr${clearedHidden === 1 ? "y is" : "ies are"} hidden; \`/errors list show:cleared only\` to review.`
              : ":green_circle: Nothing has failed recently.",
        };
      }

      // The short id is here so the next command can be typed from this message:
      // `clear` takes a prefix, and eight characters is unambiguous in practice.
      const rendered = errors.map(
        (e) =>
          `• \`${shortTime(e.at)}\` **${e.kind}** \`${e.id.slice(0, 8)}\` ${e.subject}` +
          (e.cleared ? ` _(cleared by ${e.cleared.by}${e.cleared.note ? `: ${e.cleared.note}` : ""})_` : "") +
          (e.message ? `\n   \`${e.message.slice(0, 160)}\`` : ""),
      );
      const header =
        cleared === "only"
          ? `**${errors.length} cleared entr${errors.length === 1 ? "y" : "ies"}**`
          : `**${errors.length} failure(s)**` +
            (clearedHidden > 0 && cleared === "without" ? ` · ${clearedHidden} cleared and hidden` : "");
      return { text: lines([header, ...rendered, "", "_Dealt with one? `/errors clear id:<first 8 chars>`._"]) };
    },
  },
  {
    name: "workers",
    description: "Fleet inventory and worker lifecycle.",
    sensitivity: { list: "read", drain: "mutate", activate: "mutate", revoke: "destructive" },
    ephemeral: true,
    builder: new SlashCommandBuilder()
      .setName("workers")
      .setDescription("Fleet inventory and worker lifecycle.")
      .addSubcommand((s) => s.setName("list").setDescription("Every enrolled worker with heartbeat age."))
      .addSubcommand((s) =>
        s
          .setName("drain")
          .setDescription("Stop giving a worker new jobs; in-flight work finishes.")
          .addStringOption((o) => o.setName("id").setDescription("Worker id.").setRequired(true)),
      )
      .addSubcommand((s) =>
        s
          .setName("activate")
          .setDescription("Return a drained worker to service.")
          .addStringOption((o) => o.setName("id").setDescription("Worker id.").setRequired(true)),
      )
      .addSubcommand((s) =>
        s
          .setName("revoke")
          .setDescription("Permanently kill a worker's credential.")
          .addStringOption((o) => o.setName("id").setDescription("Worker id.").setRequired(true))
          .addBooleanOption((o) =>
            o.setName("confirm").setDescription("Required: revoking cannot be undone; the host must re-enroll."),
          ),
      ),
    async run(ctx) {
      const sub = ctx.options.subcommand();
      if (sub === "list") {
        const { workers } = await ctx.api.workers(ctx.actor);
        if (workers.length === 0) {
          return { text: "No workers enrolled. Mint an enrollment token with `/enroll`." };
        }
        const rendered = workers.map(
          (w) =>
            `${workerIcon(w.status)} \`${w.name}\`: ${w.status}/${w.trust}, agent ${w.agentVersion ?? "?"}, ` +
            `heartbeat ${age(w.lastHeartbeatAt)}\n   id \`${w.id}\``,
        );
        return { text: lines([`**${workers.length} worker(s)**`, ...rendered]) };
      }
      const id = requireString(ctx.options, "id");
      if (sub === "revoke" && ctx.options.boolean("confirm") !== true) {
        return {
          text:
            `:warning: **Worker \`${id}\` not revoked.** Revocation is permanent; the host must re-enroll with a ` +
            "fresh token to come back.\nRe-issue with `confirm: true` to proceed, or use `drain` if you only want it idle.",
        };
      }
      const result = await ctx.api.workerAction(ctx.actor, id, sub as WorkerAction);
      return { text: `Worker \`${id}\` → **${result.status}**.` };
    },
  },
  {
    name: "enroll",
    description: "Mint a single-use worker enrollment token (DM'd to you).",
    sensitivity: "destructive",
    ephemeral: true,
    builder: new SlashCommandBuilder()
      .setName("enroll")
      .setDescription("Mint a single-use worker enrollment token (DM'd to you).")
      .addStringOption((o) =>
        o
          .setName("trust")
          .setDescription("TRUSTED workers may run extensions COMMUNITY ones may not.")
          .addChoices({ name: "COMMUNITY", value: "COMMUNITY" }, { name: "TRUSTED", value: "TRUSTED" }),
      )
      .addStringOption((o) => o.setName("note").setDescription("Who or what this token is for."))
      .addIntegerOption((o) =>
        o
          .setName("ttl-hours")
          .setDescription("Validity window (1-720, default 24).")
          .setMinValue(1)
          .setMaxValue(720),
      ),
    async run(ctx) {
      const trust = (ctx.options.string("trust") ?? "COMMUNITY") as "TRUSTED" | "COMMUNITY";
      const note = ctx.options.string("note");
      const ttlHours = ctx.options.integer("ttl-hours") ?? 24;
      const token = await ctx.api.createEnrollToken(ctx.actor, {
        trust,
        ttlHours,
        ...(note ? { note } : {}),
      });
      // The token is a bearer credential that becomes a worker identity. It goes
      // to the invoker's DM and never to a channel, not even an ephemeral reply
      // in one; ephemeral messages are still channel-scoped and get screen-shared.
      return {
        text: `:envelope_with_arrow: Enrollment token minted (${trust}, expires ${shortTime(token.expiresAt)}) and sent to you by DM. It is single-use and is not shown here.`,
        dm: lines([
          `**Worker enrollment token** (${trust}, expires ${shortTime(token.expiresAt)})`,
          "Single-use. Set it as `ENROLL_TOKEN` on the worker host, start the agent once, then delete it; the agent exchanges it for a long-lived worker token.",
          codeBlock(token.token),
          "If you did not ask for this, tell an admin: someone used the bot's `/enroll` command.",
        ]),
      };
    },
  },
  {
    name: "map",
    description: "Map a series from its two links: the publisher's page and the MangaDex title.",
    // Mutate rather than read even when only `source` is given. The command
    // writes the series map in its main form, and splitting the gate by which
    // options were filled in would mean the same command name is sometimes
    // allowed and sometimes not, which is worse to reason about than one answer.
    sensitivity: "mutate",
    ephemeral: true,
    builder: new SlashCommandBuilder()
      .setName("map")
      .setDescription("Map a series from its two links: the publisher's page and the MangaDex title.")
      .addStringOption((o) =>
        o
          .setName("source")
          .setDescription("The publisher's page for the series, e.g. comikey.com/comics/…")
          .setRequired(true),
      )
      .addStringOption((o) =>
        o
          .setName("mangadex")
          .setDescription("MangaDex title link or id. Leave empty to just see what the link is.")
          .setRequired(false),
      )
      .addStringOption((o) =>
        o
          .setName("manga-id")
          .setDescription("The extension's own id, for a link this cannot read on its own.")
          .setRequired(false),
      ),
    async run(ctx) {
      const source = requireString(ctx.options, "source");
      const target = ctx.options.string("mangadex");
      const override = ctx.options.string("manga-id");

      // Without a MangaDex title this is a question, not an action: "what is
      // this link". Worth answering on its own — it is how you find out whether
      // a series is already mapped before touching anything.
      if (!target) {
        const resolution = await ctx.api.resolveSource(ctx.actor, source);
        return { text: describeResolution(resolution) };
      }

      const result = await ctx.api.mapFromSource(ctx.actor, {
        url: source,
        mdMangaId: requireSeriesId(target),
        ...(override ? { mangaId: override } : {}),
      });
      const where = `\`${result.extension}\`/\`${qualified(result.namespace, result.mangaId)}\``;
      if (result.outcome === "unchanged") {
        return { text: `${where} already points at <${mdTitleUrl(result.mdMangaId)}>; nothing changed.` };
      }
      const how = viaPhrase(result.resolution.match?.via);
      if (result.outcome === "repointed") {
        return {
          text:
            `:twisted_rightwards_arrows: **Repointed** ${where} (${how}).\n` +
            `Was <${mdTitleUrl(result.previousMdMangaId ?? "")}>\nNow <${mdTitleUrl(result.mdMangaId)}>\n` +
            "Chapters already uploaded stay where they are; new ones land on the new title.",
        };
      }
      return {
        text: lines([
          `:link: ${where} → <${mdTitleUrl(result.mdMangaId)}>`,
          `Read from the link you pasted (${how}).`,
          // The queue row is the part an operator would otherwise forget, and
          // forgetting it means the series is offered for creation again.
          result.untrackedRow
            ? "The untracked queue row for this series is closed."
            : (result.untrackedNote ?? ""),
        ].filter(Boolean)),
      };
    },
  },
  {
    name: "map-many",
    description: "Map several series at once from pasted publisher and MangaDex links.",
    // Same gate as /map: this writes the series map, in bulk.
    sensitivity: "mutate",
    ephemeral: true,
    builder: new SlashCommandBuilder()
      .setName("map-many")
      .setDescription("Map several series at once from pasted publisher and MangaDex links."),
    /**
     * A paste box, because that is what a backlog looks like.
     *
     * Twenty tabs open on a publisher's new-releases page is the case this
     * exists for, and a slash option is one line. Discord's paragraph field
     * holds roughly forty pairs, which is a session's worth.
     *
     * It applies rather than previewing: the modal shows the operator exactly
     * what they pasted before they submit it, every row's outcome comes back
     * afterwards, and a repoint still needs `tracked:write` — which the bot's
     * own token preset deliberately lacks, so a paste through here cannot move
     * a live series without someone having widened that token on purpose.
     * Previewing a large paste belongs on the dashboard, which can show a table.
     */
    modal: {
      title: "Map series from links",
      fields: [
        {
          name: "pairs",
          label: "Publisher link + MangaDex link per line",
          paragraph: true,
          placeholder: "https://comikey.com/comics/a-series https://mangadex.org/title/<uuid>",
        },
      ],
    },
    async run(ctx) {
      const report = await ctx.api.mapSourceBatch(ctx.actor, {
        text: requireString(ctx.options, "pairs"),
      });

      const changed = report.added + report.updated;
      const head =
        changed === 0 && report.unresolved === 0 && report.failed === 0
          ? ":ok_hand: Nothing to do; every line already pointed where you asked."
          : `:link: **${report.added} added, ${report.updated} repointed**` +
            (report.unchanged ? `, ${report.unchanged} already there` : "") +
            (report.unresolved ? `, ${report.unresolved} not placed` : "") +
            (report.failed ? `, ${report.failed} refused` : "") +
            (report.closedQueueRows ? `\n${report.closedQueueRows} untracked queue row(s) closed.` : "");

      // The rows worth reading are the ones that did NOT simply work: a paste of
      // twenty wants the three that need a decision, not twenty confirmations.
      const problems = report.results.filter(
        (row) => row.outcome !== "added" && row.outcome !== "updated" && row.outcome !== "unchanged",
      );
      const rendered = problems
        .slice(0, 15)
        .map(
          (row) =>
            `• \`${short(row.sourceUrl, 60)}\` — **${row.outcome}**` +
            (row.detail ? `: ${short(row.detail, 90)}` : ""),
        );
      if (problems.length > 15) rendered.push(`…and ${problems.length - 15} more`);
      for (const parse of report.parseErrors.slice(0, 5)) {
        rendered.push(`• line ${parse.line}: ${short(parse.reason, 90)}`);
      }
      if (report.parseErrors.length > 5) {
        rendered.push(`…and ${report.parseErrors.length - 5} more unreadable line(s)`);
      }
      if (report.results.some((row) => row.outcome === "rejected_needs_write")) {
        rendered.push(
          "Rows marked `rejected_needs_write` would repoint a series that is already mapped, " +
            "which this token may not do. Repoint them on the dashboard, or with a token holding `tracked:write`.",
        );
      }
      if (report.untrackedNote) rendered.push(report.untrackedNote);

      return { text: lines([head, ...rendered]) };
    },
  },
  {
    name: "untracked",
    description: "Series reported with no MangaDex title yet.",
    // `map` is a mutate, not a destructive: it writes the series map but
    // creates nothing on MangaDex and is reversible with /tracked remove.
    // `approve` stays destructive because it creates a public title that
    // nothing here can delete.
    sensitivity: {
      list: "read",
      search: "read",
      map: "mutate",
      automap: "mutate",
      approve: "destructive",
      skip: "mutate",
    },
    ephemeral: true,
    builder: new SlashCommandBuilder()
      .setName("untracked")
      .setDescription("Series reported with no MangaDex title yet.")
      .addSubcommand((s) =>
        s
          .setName("list")
          .setDescription("Untracked series awaiting a decision.")
          .addStringOption((o) =>
            o
              .setName("state")
              .setDescription("Filter by state (default: all).")
              .addChoices(
                { name: "NEW", value: "NEW" },
                { name: "CREATING", value: "CREATING" },
                { name: "CREATED", value: "CREATED" },
                { name: "TRACKED", value: "TRACKED" },
                { name: "FAILED", value: "FAILED" },
                { name: "SKIPPED", value: "SKIPPED" },
              ),
          )
          .addStringOption((o) =>
            o.setName("extension").setDescription("Only this extension.").setAutocomplete(true),
          )
          .addStringOption((o) =>
            o.setName("q").setDescription("Match the series name, the source's id, or the extension."),
          )
          .addIntegerOption((o) =>
            o.setName("limit").setDescription("How many (1-100, default 20).").setMinValue(1).setMaxValue(100),
          ),
      )
      .addSubcommand((s) =>
        s
          .setName("search")
          .setDescription("Look for the series on MangaDex before creating a second title for it.")
          .addStringOption((o) => untrackedIdOption(o).setRequired(false))
          .addStringOption((o) =>
            o.setName("title").setDescription("Search this instead of the queued row's own name."),
          ),
      )
      .addSubcommand((s) =>
        s
          .setName("map")
          .setDescription("Track this series against a MangaDex title that already exists.")
          .addStringOption((o) => untrackedIdOption(o).setRequired(true))
          .addStringOption((o) =>
            o
              .setName("mangadex")
              .setDescription("MangaDex title link (mangadex.org/title/…) or the bare title id.")
              .setRequired(true),
          ),
      )
      .addSubcommand((s) =>
        s
          .setName("automap")
          .setDescription("Map queued series MangaDex already lists under their own publisher link.")
          .addStringOption((o) =>
            o.setName("extension").setDescription("Only this extension.").setAutocomplete(true),
          )
          .addIntegerOption((o) =>
            o.setName("limit").setDescription("How many rows to check (1-200, default 25).").setMinValue(1).setMaxValue(200),
          )
          .addBooleanOption((o) =>
            o.setName("commit").setDescription("Write the mappings. Without it this is a dry run."),
          ),
      )
      .addSubcommand((s) =>
        s
          .setName("approve")
          .setDescription("Create the MangaDex title now and start tracking it.")
          .addStringOption((o) => untrackedIdOption(o).setRequired(true))
          .addBooleanOption((o) =>
            o.setName("confirm").setDescription("Required: this creates a real MangaDex title and cannot be undone."),
          ),
      )
      .addSubcommand((s) =>
        s
          .setName("skip")
          .setDescription("Never create a title for this series.")
          .addStringOption((o) => untrackedIdOption(o).setRequired(true)),
      ),
    async run(ctx) {
      const sub = ctx.options.subcommand();
      if (sub === "list") {
        const state = ctx.options.string("state");
        const extension = ctx.options.string("extension");
        const q = ctx.options.string("q");
        const { untracked, total } = await ctx.api.untracked(ctx.actor, {
          limit: ctx.options.integer("limit") ?? 20,
          ...(state ? { state: state as UntrackedState } : {}),
          ...(extension ? { extension: requireExtensionName(extension) } : {}),
          ...(q ? { q } : {}),
        });
        if (untracked.length === 0) return { text: "Nothing untracked matches that." };
        const rendered = untracked.map(
          (u) =>
            `• \`${u.id}\` **${u.extension}** ${u.state}; ${nameOf(u)} (${shortTime(u.createdAt)})`,
        );
        return {
          text: lines([
            `**${untracked.length}${total && total > untracked.length ? ` of ${total}` : ""} untracked series**` +
              "\nMost of these already exist on MangaDex: `/untracked search` first, then " +
              "`/untracked map`. `/untracked approve` creates a NEW title.",
            ...rendered,
          ]),
        };
      }

      if (sub === "automap") {
        const extension = ctx.options.string("extension");
        const commit = ctx.options.boolean("commit") === true;
        const report = await ctx.api.automapUntracked(ctx.actor, {
          dryRun: !commit,
          limit: ctx.options.integer("limit") ?? 25,
          ...(extension ? { extension: requireExtensionName(extension) } : {}),
        });
        const rendered = report.mapped
          .slice(0, 20)
          .map((m) => `• **${m.extension}** ${short(m.mangaName, 60)} → <${m.titleUrl}>`);
        if (report.mapped.length > 20) rendered.push(`…and ${report.mapped.length - 20} more`);
        return {
          text: lines([
            commit
              ? `:link: **Auto-mapped ${report.mapped.length}** of ${report.considered} checked.`
              : `**Dry run; nothing was written.** ${report.mapped.length} of ${report.considered} checked would map.`,
            // The queue depth is the number that decides whether to run it
            // again: a pass that maps nothing is normal at this hit rate.
            `ambiguous ${report.ambiguous} · unmatched ${report.unmatched} · still queued ${report.remaining}`,
            ...rendered,
            commit ? "" : "Re-issue with `commit: true` to write these.",
          ].filter(Boolean)),
        };
      }

      if (sub === "search") {
        // Either a row to search for, or a title to search with. With a row and
        // no title the row's own scraped name is the query, which is the case
        // this exists for; the title option is the second try when that name is
        // the reason nothing matched.
        const id = ctx.options.string("id");
        const typed = ctx.options.string("title");
        let reportedName: string | undefined;
        let query = typed?.trim();
        if (id) {
          const row = await findUntracked(ctx, id);
          reportedName = nameOf(row);
          query = query || reportedName;
        }
        if (!query) {
          throw new UserError("Give a queued series (`id`) to search for, or a `title` to search with.");
        }
        const { results } = await ctx.api.searchMangadex(ctx.actor, {
          q: query,
          ...(reportedName ? { reportedName } : {}),
          limit: 10,
        });
        if (results.length === 0) {
          return {
            text:
              `MangaDex returned nothing for **${short(query, 80)}**. A narrower or romanised title often ` +
              "finds it; if it genuinely is not there, `/untracked approve` creates it.",
          };
        }
        const rendered = results.map(
          (r) =>
            `• ${r.likely ? ":dart: " : ""}[${short(r.title, 70)}](${r.url})` +
            (r.altTitles.length ? `\n  ${short(r.altTitles.join(" · "), 90)}` : ""),
        );
        return {
          text: lines([
            `**${results.length} candidate(s) for ${short(query, 60)}**` +
              (id ? `\nMap one with \`/untracked map id:${id} mangadex:<link>\`.` : "") +
              "\n:dart: marks a match on the scraped name. Nothing is written until you map one.",
            ...rendered,
          ]),
        };
      }

      const id = requireString(ctx.options, "id");
      if (sub === "skip") {
        await ctx.api.skipUntracked(ctx.actor, id);
        return { text: `:no_bell: \`${id}\` marked SKIPPED; no title will be created for it.` };
      }
      if (sub === "map") {
        const mdMangaId = requireSeriesId(requireString(ctx.options, "mangadex"));
        const result = await ctx.api.mapUntracked(ctx.actor, id, mdMangaId);
        return {
          text:
            `:link: \`${id}\` is now tracked against <${mdTitleUrl(result.mdMangaId ?? mdMangaId)}>.\n` +
            "No title was created; its chapters upload to that one from the next run onwards.",
        };
      }
      if (ctx.options.boolean("confirm") !== true) {
        return {
          text:
            `:warning: **\`${id}\` not approved.** Approving creates a real title on MangaDex immediately and ` +
            "cannot be undone from this API.\nRun `/untracked search id:" +
            `${id}\` first: if it is already there, \`/untracked map\` is the answer instead.` +
            "\nRe-issue with `confirm: true` to proceed.",
        };
      }
      const result = await ctx.api.approveUntracked(ctx.actor, id);
      return {
        text: `:white_check_mark: Title created and tracked${result.mdMangaId ? `: <${mdTitleUrl(result.mdMangaId)}>` : ""}.`,
      };
    },
  },
  {
    name: "reconcile",
    description: "Check how far our record of the chapters has drifted from MangaDex.",
    // "read" although it walks the whole catalogue: it reports and never
    // writes. Applying is closed to api tokens at the endpoint, so this command
    // could not write the rows even if it asked to; `padmin chapters
    // reconcile --apply` or the dashboard does that.
    sensitivity: "read",
    ephemeral: true,
    builder: new SlashCommandBuilder()
      .setName("reconcile")
      .setDescription("Check how far our record of the chapters has drifted from MangaDex.")
      .addStringOption((o) =>
        o
          .setName("extension")
          .setDescription("Only this extension. Omit for every group we have uploaded to.")
          .setAutocomplete(true),
      ),
    async run(ctx) {
      const extension = ctx.options.string("extension");
      const started = await ctx.api.startChapterReconcile(ctx.actor, extension ? [extension] : []);

      // The pass takes minutes -- a group walk is ~124 MangaDex requests at the
      // client's rate limit -- and a Discord interaction cannot be left that
      // long. So this waits as long as it safely can and then reports where the
      // pass got to; the pass itself carries on, and asking again picks it up.
      const report = await waitForPass(started, () => ctx.api.reconcileStatus(ctx.actor));
      if (!report) {
        const status = await ctx.api.reconcileStatus(ctx.actor);
        if (status.state === "failed") {
          return { text: `:x: The reconcile pass failed: \`${status.error ?? "no reason given"}\`` };
        }
        return {
          text: stillWorkingText(status.progress?.steps ?? [], {
            what: "reading MangaDex",
            alreadyRunning: !started.started,
            command: "/reconcile",
          }),
        };
      }

      const missing =
        report.unavailableRecorded + report.deletedRecorded + report.untrackedFound;
      if (missing === 0) {
        return {
          text:
            ":white_check_mark: Nothing to record; our record already matches MangaDex " +
            `(${report.unavailableFound} unavailable and ${report.deletedFound} deleted, all known, ` +
            "and every live chapter has a row).",
        };
      }
      const lines = report.groups
        .filter(
          (group) => group.carded > 0 || group.hiddenOnMangadex > 0 || group.untracked > 0,
        )
        .map(
          (group) =>
            `• **${group.extension}**: ${group.carded} of ${group.total} already carded, ` +
            `${group.recorded} not yet archived` +
            (group.untracked > 0
              ? `, and **${group.untracked}** of ${group.live} live chapter(s) have no row here`
              : "") +
            (group.hiddenOnMangadex > 0
              ? `, ${group.hiddenOnMangadex} live but unserved by MangaDex`
              : ""),
        );
      return {
        text:
          `:mag: **${report.unavailableRecorded}** unavailable and **${report.deletedRecorded}** ` +
          `deleted chapter(s) are missing from the archives, and **${report.untrackedFound}** ` +
          "live chapter(s) on MangaDex are untracked here.\n" +
          (lines.length > 0 ? `${lines.join("\n")}\n` : "") +
          (report.untrackedFound > 0
            ? "An untracked chapter is not just invisible: its id never reaches the extension as " +
              "`postedChapterIds`, so the extension re-fetches it on every run.\n"
            : "") +
          (report.hiddenOnMangadex.length > 0
            ? `${report.hiddenOnMangadex.length} chapter(s) carry no card but MangaDex will not ` +
              "serve them, never archived; queue them unavailable if that is what you want.\n"
            : "") +
          "Nothing has been written. Run `padmin chapters reconcile --apply` to record them.",
      };
    },
  },
  {
    name: "duplicates",
    description: "Find the chapters MangaDex holds twice, per series.",
    // Read, like /reconcile and for the same reason: the scan itself writes
    // nothing, and queuing the deletions is closed to api tokens at the
    // endpoint. What belongs in a channel is the finding — "these 14 chapters
    // are duplicated" — and the one line that acts on it.
    sensitivity: "read",
    ephemeral: true,
    builder: new SlashCommandBuilder()
      .setName("duplicates")
      .setDescription("Find the chapters MangaDex holds twice, per series.")
      .addStringOption((o) =>
        o
          .setName("extension")
          .setDescription("Only this extension. Omit for every group we have uploaded to.")
          .setAutocomplete(true),
      )
      .addStringOption((o) =>
        o
          .setName("manga")
          .setDescription("Only this MangaDex title id. Much faster than a whole-group scan."),
      ),
    async run(ctx) {
      const extension = ctx.options.string("extension");
      const manga = ctx.options.string("manga");
      const started = await ctx.api.startChapterDuplicates(
        ctx.actor,
        extension ? [extension] : [],
        manga ? [manga] : [],
      );

      // Same shape as /reconcile: an unscoped scan walks a whole group, which
      // is minutes of MangaDex requests and longer than an interaction may be
      // left unanswered. Scoped to one title it usually answers first time.
      const report = await waitForPass(started, () => ctx.api.duplicatesStatus(ctx.actor));
      if (!report) {
        const status = await ctx.api.duplicatesStatus(ctx.actor);
        if (status.state === "failed") {
          return { text: `:x: The duplicate scan failed: \`${status.error ?? "no reason given"}\`` };
        }
        return {
          text: stillWorkingText(status.progress?.steps ?? [], {
            what: "reading MangaDex",
            alreadyRunning: !started.started,
            command: "/duplicates",
          }),
        };
      }

      if (report.duplicatesFound === 0) {
        return {
          text:
            ":white_check_mark: No duplicates: " +
            `${report.seriesScanned} series checked and every chapter appears once.`,
        };
      }

      const lines = report.series
        .slice(0, 10)
        .map(
          (series) =>
            `• **${series.mangaName ?? series.mdMangaId}** — ${series.removeCount} duplicate(s) ` +
            `of ${series.chaptersOnMd} chapter(s) (\`${series.mdMangaId}\`)`,
        );
      const listed = Math.min(report.series.length, 10);
      const rest = report.seriesWithDuplicates - listed;

      return {
        text:
          `:mag: **${report.duplicatesFound}** duplicate chapter(s) across ` +
          `**${report.seriesWithDuplicates}** of ${report.seriesScanned} series.\n` +
          `${lines.join("\n")}\n` +
          (rest > 0 ? `…and ${rest} more series.\n` : "") +
          "The oldest copy of each is the one that would survive. Nothing has been deleted: " +
          "run `padmin chapters duplicates --chapters` to see every id, then " +
          "`padmin chapters duplicates --apply` to queue the deletions.",
      };
    },
  },
  {
    name: "recard",
    description: "Which titles have unavailable card images up, and how to re-post them.",
    // Read, and not by choice: queuing card images is closed to api tokens at
    // the endpoint, so a `pa_…` token could not re-post a card even if this
    // asked it to. What the bot can do is the half that happens in a channel
    // anyway — somebody reports a bad card, and the answer is which title it
    // is, how many pages would move, and the one line that moves them.
    sensitivity: "read",
    ephemeral: true,
    builder: new SlashCommandBuilder()
      .setName("recard")
      .setDescription("Which titles have unavailable card images up, and how to re-post them.")
      .addStringOption((o) =>
        o
          .setName("series")
          .setDescription("A title, by name or MangaDex id. Omit for the titles with the most cards up.")
          .setAutocomplete(true),
      )
      .addStringOption((o) =>
        o.setName("extension").setDescription("Only chapters this extension uploaded.").setAutocomplete(true),
      ),
    async run(ctx) {
      const series = ctx.options.string("series");
      const extension = ctx.options.string("extension");
      const report = await ctx.api.archiveSeries(ctx.actor, {
        archive: "unavailable",
        search: series ?? undefined,
        extension: extension ?? undefined,
        limit: series ? 5 : 10,
      });

      const where = extension ? ` uploaded by **${extension}**` : "";
      if (report.series.length === 0) {
        return {
          text: series
            ? `:mag: No title${where} matching \`${series}\` has a card image up.`
            : `:white_check_mark: No chapter${where} is marked unavailable, so there is no card to re-post.`,
        };
      }

      // An exact id, or a name that matched one title and only one, is a
      // target; anything else is a shortlist, and offering a command line for a
      // title the operator has not actually chosen is how the wrong series gets
      // re-carded.
      const exact =
        report.series.length === 1
          ? report.series[0]
          : report.series.find((entry) => entry.mdMangaId === series?.trim());

      const lines = report.series.map(
        (entry) =>
          `• **${entry.mangaName ?? "(unnamed)"}** — ${entry.count} card(s) up, ` +
          `${entry.extensions.map((name) => name || "(unattributed)").join(", ")}\n` +
          `  \`${entry.mdMangaId}\``,
      );

      if (!exact) {
        return {
          text:
            `:mag: ${report.series.length} title(s)${where} with card images up` +
            (report.capped ? ", the largest shown" : "") +
            `:\n${lines.join("\n")}\n` +
            "Name one of them to get the command that re-posts its cards.",
        };
      }

      const narrow = extension ? ` --extension ${extension}` : "";
      return {
        text:
          `:card_index: **${exact.mangaName ?? exact.mdMangaId}** has **${exact.count}** ` +
          `unavailable card image(s) up${where}, most recently ${exact.at}.\n` +
          "Re-rendering them replaces each page with a fresh card and keeps the chapter's own " +
          "unavailable-since date; it never cards a chapter for the first time.\n" +
          "Nothing has been queued: the bot's token cannot post card images. Do it from " +
          "**System → Unavailable cards** on the dashboard, or run\n" +
          `\`\`\`\npadmin chapters recard --series ${exact.mdMangaId}${narrow} --apply\n\`\`\``,
      };
    },
  },
  {
    name: "recheck",
    description: "Ask the publisher whether chapters are still there, for one series or a whole extension.",
    // Mutate, not read: what comes back from the publisher is turned into real
    // UNAVAILABLE (or DELETE) tasks against live MangaDex pages. It is the same
    // machinery /run drives, and it is gated the same way — including the
    // explicit confirm a CLEAN needs there.
    sensitivity: "mutate",
    ephemeral: true,
    builder: new SlashCommandBuilder()
      .setName("recheck")
      .setDescription("Ask the publisher whether chapters are still there, for one series or a whole extension.")
      .addStringOption((o) =>
        o
          .setName("series")
          .setDescription("One series, by name or MangaDex id. Omit to re-check a whole extension.")
          .setAutocomplete(true),
      )
      .addStringOption((o) =>
        o
          .setName("extension")
          .setDescription("With a series: which extension to ask. Without one: re-check all of it.")
          .setAutocomplete(true),
      )
      .addBooleanOption((o) =>
        o.setName("confirm").setDescription("Start the run. Without it this only reports what it would cover."),
      ),
    async run(ctx) {
      const rawSeries = ctx.options.string("series");
      const extension = ctx.options.string("extension");
      const apply = ctx.options.boolean("confirm") === true;
      if (!rawSeries && !extension) {
        throw new UserError(
          "Name a `series` to re-check one title, or an `extension` on its own to re-check all of it.",
        );
      }
      // One key per interaction, for the same reason /run has one: a Discord
      // retry must collapse into the same run rather than scrape twice.
      const idempotencyKey = `discord:${ctx.interactionId}`;
      const result = rawSeries
        ? await ctx.api.recheckSeries(ctx.actor, {
            mdMangaId: requireSeriesId(rawSeries),
            extension: extension ?? undefined,
            apply,
            idempotencyKey,
          })
        : await ctx.api.recheckExtension(ctx.actor, {
            extension: requireExtensionName(extension),
            apply,
            idempotencyKey,
          });

      const whole = result.target === "extension";
      const holdings = whole
        ? `**${result.trackedSeries ?? 0}** tracked series, ${result.knownChapters ?? 0} chapter(s) ` +
          "we have a row for"
        : result.onMangadex === null
          ? "MangaDex holdings unknown (the API holds no MangaDex credentials)"
          : `**${result.onMangadex}** chapter(s) on MangaDex, ${result.carded ?? 0} already carded, ` +
            `**${result.candidates ?? 0}** that this could mark`;
      const caveat = result.publishesCatalogue
        ? ""
        : `\n:warning: \`${result.extension}\` has not sent a full catalogue listing recently. ` +
          "Removal detection is computed from one, so this will probably find nothing.";
      const queued = `**${result.removalMode === "delete" ? "DELETE" : "UNAVAILABLE"}**`;

      if (!apply) {
        return {
          text: whole
            ? `:warning: This would re-scrape **all of \`${result.extension}\`** and ask it for its ` +
              `current listing of every series it tracks.\n${holdings}; anything on MangaDex it no ` +
              `longer lists is queued as ${queued}. If its listing comes back empty, so is ` +
              `everything we have published for it.${caveat}\n` +
              "Nothing has been started. Re-issue with `confirm: true` to start the run."
            : `:mag: Re-checking this series would ask \`${result.extension}\` (as \`${result.mangaId}\`) ` +
              `for its current listing.\n${holdings}; anything it no longer lists is queued as ` +
              `${queued}.${caveat}\n` +
              "Nothing has been started. Re-issue with `confirm: true` to start the run.",
        };
      }
      if (!result.created) {
        return {
          text: `:information_source: A run for that exact request already existed: \`${result.runId}\` (nothing new was created).`,
        };
      }
      return {
        text:
          (whole
            ? `:satellite: Full re-check started for \`${result.extension}\`: run \`${result.runId}\`.\n`
            : `:satellite: Re-check started for this series via \`${result.extension}\`: run \`${result.runId}\`.\n`) +
          `${holdings}.${caveat}\nFollow it with \`/runs show id:${result.runId}\`, then \`/queue list kind:UNAVAILABLE\`.`,
      };
    },
  },
  {
    name: "tracked",
    description: "The external-id to MangaDex-id mapping for an extension.",
    // Pausing is a mutate, not a destructive: it changes what runs cover but
    // takes nothing down, and it is reversible with one unpause.
    sensitivity: { list: "read", set: "mutate", remove: "mutate", pause: "mutate", unpause: "mutate", paused: "read" },
    ephemeral: true,
    builder: new SlashCommandBuilder()
      .setName("tracked")
      .setDescription("The external-id to MangaDex-id mapping for an extension.")
      .addSubcommand((s) =>
        s
          .setName("list")
          .setDescription("Every tracked manga for an extension.")
          .addStringOption(extensionOption)
          .addStringOption((o) => catalogueOption(o)),
      )
      .addSubcommand((s) =>
        s
          .setName("set")
          .setDescription("Add or repoint a mapping. Paste the MangaDex link; the id is read out of it.")
          .addStringOption(extensionOption)
          .addStringOption((o) => mangaIdOption(o))
          .addStringOption((o) =>
            o
              .setName("mangadex")
              .setDescription("MangaDex title link (mangadex.org/title/…) or the bare title id.")
              .setRequired(true),
          )
          .addStringOption((o) => catalogueOption(o)),
      )
      .addSubcommand((s) =>
        s
          .setName("remove")
          .setDescription("Stop tracking a manga. Does not touch MangaDex.")
          .addStringOption(extensionOption)
          .addStringOption((o) => mangaIdOption(o))
          .addStringOption((o) => catalogueOption(o)),
      )
      .addSubcommand((s) =>
        s
          .setName("pause")
          .setDescription("Leave a series out of runs until its cooldown expires.")
          .addStringOption(extensionOption)
          .addStringOption((o) => mangaIdOption(o))
          .addIntegerOption((o) =>
            o
              .setName("days")
              .setDescription(`How long to pause for (default ${DEFAULT_COOLDOWN_DAYS}).`)
              .setMinValue(1)
              .setMaxValue(MAX_COOLDOWN_DAYS),
          )
          .addBooleanOption((o) =>
            o.setName("once").setDescription("A one-shot hold: it expires for good instead of re-arming."),
          )
          .addStringOption((o) => o.setName("reason").setDescription("Why, for whoever reads this later."))
          .addStringOption((o) => catalogueOption(o)),
      )
      .addSubcommand((s) =>
        s
          .setName("unpause")
          .setDescription("Put a paused series back in runs immediately.")
          .addStringOption(extensionOption)
          .addStringOption((o) => mangaIdOption(o))
          .addStringOption((o) => catalogueOption(o)),
      )
      .addSubcommand((s) =>
        s
          .setName("paused")
          .setDescription("Series currently suppressed from runs, soonest to return first.")
          .addStringOption(extensionOption),
      ),
    async run(ctx) {
      const sub = ctx.options.subcommand();
      const extension = requireExtensionName(ctx.options.string("extension"));
      const catalogue = optionalCatalogue(ctx.options);
      if (sub === "list") {
        const { tracked, namespaces } = await ctx.api.tracked(ctx.actor, extension, catalogue);
        if (tracked.length === 0) {
          return {
            text: catalogue
              ? `\`${extension}\` tracks nothing in \`${catalogue}\`.`
              : `\`${extension}\` tracks nothing yet. Add one with \`/tracked set\`.`,
          };
        }
        const rendered = tracked
          .slice(0, 30)
          .map((t) => `• \`${qualified(t.namespace, t.mangaId)}\` → <${mdTitleUrl(t.mdMangaId)}>`);
        if (tracked.length > 30) rendered.push(`…and ${tracked.length - 30} more`);
        // Only worth saying where there is more than the flat id space: for
        // every extension but viz this line would be noise on every call.
        const others = (namespaces ?? []).filter(Boolean);
        if (!catalogue && others.length > 0) rendered.push(`catalogues: ${others.join(", ")}`);
        return { text: lines([`**${tracked.length} tracked manga for \`${extension}\`**`, ...rendered]) };
      }
      if (sub === "paused") {
        const { paused } = await ctx.api.pausedTracked(ctx.actor, extension);
        if (paused.length === 0) return { text: `Nothing is paused for \`${extension}\`.` };
        const rendered = paused
          .slice(0, 30)
          .map(
            (p) =>
              `• \`${qualified(p.namespace, p.mangaId)}\` returns ${shortTime(p.recheckAfter)}` +
              (p.cooldownDays ? ` (every ${p.cooldownDays}d)` : " (once)") +
              (p.pauseReason ? ` — ${p.pauseReason}` : ""),
          );
        if (paused.length > 30) rendered.push(`…and ${paused.length - 30} more`);
        return { text: lines([`**${paused.length} paused series in \`${extension}\`**`, ...rendered]) };
      }
      const mangaId = requireString(ctx.options, "manga-id");
      const where = `\`${extension}\`/\`${qualified(catalogue, mangaId)}\``;
      if (sub === "remove") {
        const result = await ctx.api.removeTracked(ctx.actor, extension, mangaId, catalogue);
        return {
          text: result.removed
            ? `:wastebasket: ${where} is no longer tracked. Nothing on MangaDex was changed.`
            : `${where} was not tracked; nothing changed.`,
        };
      }
      if (sub === "pause") {
        const days = ctx.options.integer("days") ?? DEFAULT_COOLDOWN_DAYS;
        const renew = ctx.options.boolean("once") !== true;
        const reason = ctx.options.string("reason");
        const result = await ctx.api.pauseTracked(ctx.actor, extension, {
          mangaIds: [mangaId],
          days,
          renew,
          ...(catalogue ? { namespace: catalogue } : {}),
          ...(reason ? { reason } : {}),
        });
        if (result.changed === 0) {
          return { text: `${where} is not tracked; nothing was paused.` };
        }
        return {
          text:
            `:pause_button: ${where} is out of runs until ` +
            `${shortTime(result.recheckAfter)}` +
            (renew ? `, then re-arms every ${days} days after each clean run.` : " (one-shot).") +
            "\nIt is neither fetched nor considered for removal while paused; " +
            "its chapters on MangaDex are untouched.",
        };
      }
      if (sub === "unpause") {
        const result = await ctx.api.unpauseTracked(ctx.actor, extension, {
          mangaIds: [mangaId],
          ...(catalogue ? { namespace: catalogue } : {}),
        });
        return {
          text:
            result.changed > 0
              ? `:arrow_forward: ${where} is back in runs from the next one onwards.`
              : `${where} is not tracked; nothing changed.`,
        };
      }
      const mdMangaId = requireSeriesId(requireString(ctx.options, "mangadex"));
      // What was already there decides whether this reads as an add or as a
      // repoint. A repoint changes where a live series' chapters land and is
      // invisible afterwards, so the reply has to say which one happened —
      // this is the only place an operator will see it.
      let before: TrackedEntry | undefined;
      try {
        const { tracked } = await ctx.api.tracked(ctx.actor, extension, catalogue);
        before = tracked.find((t) => t.mangaId === mangaId && (t.namespace ?? "") === (catalogue ?? ""));
      } catch {
        // The mapping is the job; failing to describe it beforehand is not a
        // reason to refuse to do it.
      }
      if (before && before.mdMangaId === mdMangaId) {
        return { text: `${where} already points at <${mdTitleUrl(mdMangaId)}>; nothing changed.` };
      }
      await ctx.api.setTracked(ctx.actor, extension, {
        mangaId,
        mdMangaId,
        ...(catalogue ? { namespace: catalogue } : {}),
      });
      if (before) {
        return {
          text:
            `:twisted_rightwards_arrows: **Repointed** ${where}.\n` +
            `Was <${mdTitleUrl(before.mdMangaId)}>\nNow <${mdTitleUrl(mdMangaId)}>\n` +
            "Chapters already uploaded stay where they are; new ones land on the new title.",
        };
      }
      return { text: `:link: ${where} → <${mdTitleUrl(mdMangaId)}>` };
    },
  },
  {
    name: "audit",
    description: "Who did what to the platform, most recent first.",
    sensitivity: "read",
    ephemeral: true,
    builder: new SlashCommandBuilder()
      .setName("audit")
      .setDescription("Who did what to the platform, most recent first.")
      .addIntegerOption((o) =>
        o.setName("limit").setDescription("How many events (1-50, default 20).").setMinValue(1).setMaxValue(50),
      ),
    async run(ctx) {
      const { events } = await ctx.api.audit(ctx.actor, ctx.options.integer("limit") ?? 20);
      if (events.length === 0) return { text: "No audit events recorded." };
      const rendered = events.map(
        (e) => `• \`${shortTime(e.createdAt)}\` **${e.action}** ${e.target ? `\`${e.target}\` ` : ""}; ${e.actor}`,
      );
      return { text: lines([`**${events.length} audit event(s)**`, ...rendered]) };
    },
  },
  {
    name: "permissions",
    description: "What each role may do here, and per-account grants and denials.",
    // Reads are read; every write grants or removes authority over the control
    // plane, which is the definition of destructive in this bot's taxonomy.
    sensitivity: {
      roles: "read",
      user: "read",
      "set-role": "destructive",
      "reset-role": "destructive",
      "set-user": "destructive",
    },
    ephemeral: true,
    builder: new SlashCommandBuilder()
      .setName("permissions")
      .setDescription("What each role may do here, and per-account grants and denials.")
      .addSubcommand((s) =>
        s.setName("roles").setDescription("The scope baseline behind each role on this deployment."),
      )
      .addSubcommand((s) =>
        s
          .setName("user")
          .setDescription("One account's permissions and the parts that produced them.")
          .addStringOption((o) => o.setName("id").setDescription("Account id.").setRequired(true)),
      )
      .addSubcommand((s) =>
        s
          .setName("set-role")
          .setDescription("Redefine what a role may do. Replaces the whole list.")
          .addStringOption((o) =>
            o
              .setName("role")
              .setDescription("Which role.")
              .setRequired(true)
              .addChoices({ name: "ADMIN", value: "ADMIN" }, { name: "CONTRIBUTOR", value: "CONTRIBUTOR" }),
          )
          .addStringOption((o) =>
            o.setName("scopes").setDescription("Comma-separated scopes.").setRequired(true),
          )
          .addBooleanOption((o) =>
            o.setName("confirm").setDescription("Yes, change what this role may do.").setRequired(true),
          ),
      )
      .addSubcommand((s) =>
        s
          .setName("reset-role")
          .setDescription("Drop a custom baseline and track the shipped default again.")
          .addStringOption((o) =>
            o
              .setName("role")
              .setDescription("Which role.")
              .setRequired(true)
              .addChoices({ name: "ADMIN", value: "ADMIN" }, { name: "CONTRIBUTOR", value: "CONTRIBUTOR" }),
          )
          .addBooleanOption((o) =>
            o.setName("confirm").setDescription("Yes, restore the shipped default.").setRequired(true),
          ),
      )
      .addSubcommand((s) =>
        s
          .setName("set-user")
          .setDescription("Grant and deny scopes for one account. Both lists are replaced.")
          .addStringOption((o) => o.setName("id").setDescription("Account id.").setRequired(true))
          .addStringOption((o) => o.setName("grant").setDescription("Comma-separated scopes to add."))
          .addStringOption((o) => o.setName("deny").setDescription("Comma-separated scopes to refuse."))
          .addBooleanOption((o) =>
            o.setName("confirm").setDescription("Yes, change what this account may do.").setRequired(true),
          ),
      ),
    async run(ctx) {
      const sub = ctx.options.subcommand();
      /** `a, b ,c` → ["a","b","c"]. An omitted option stays undefined. */
      const list = (name: string): string[] | undefined => {
        const raw = ctx.options.string(name);
        if (raw === null || raw === undefined) return undefined;
        return [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
      };
      const code = (scopes: string[]): string =>
        scopes.length ? scopes.map((s) => `\`${s}\``).join(", ") : "_none_";

      if (sub === "roles") {
        const { roles, tunableRoles } = await ctx.api.permissions(ctx.actor);
        const rendered = roles.map((r) => {
          const source = r.custom ? " *(customised here)*" : r.tunable ? "" : " *(fixed)*";
          return `• **${r.role}**${source}\n  ${code(r.scopes)}`;
        });
        return {
          text: lines([
            "**Role baselines**",
            ...rendered,
            `_Tunable: ${tunableRoles.join(", ")}. OWNER is the wildcard by construction._`,
          ]),
        };
      }

      if (sub === "user") {
        const perms = await ctx.api.userPermissions(ctx.actor, requireString(ctx.options, "id"));
        const parts = [
          `**${perms.email}** — ${perms.role}`,
          `**Role baseline**: ${code(perms.baseline)}`,
          `**Granted on top**: ${code(perms.extraScopes)}`,
          `**Denied**: ${code(perms.deniedScopes)}`,
          `**Effective**: ${code(perms.effective)}`,
        ];
        if (!perms.tunable) {
          parts.push("_This account is an OWNER: it holds every scope and ignores grants and denials._");
        }
        return { text: lines(parts) };
      }

      // Discord makes the option mandatory to *supply*; it is still the
      // handler's job to insist it says yes.
      if (ctx.options.boolean("confirm") !== true) {
        return {
          text:
            "Changing permissions changes what other people may do to the platform, and takes effect on sessions " +
            "that are already open.\nRe-issue with `confirm: true` if that is what you want.",
        };
      }

      if (sub === "reset-role") {
        const role = requireString(ctx.options, "role");
        const res = await ctx.api.resetRolePermissions(ctx.actor, role);
        return { text: `:arrows_counterclockwise: **${res.role}** is back on the shipped default: ${code(res.scopes)}` };
      }

      if (sub === "set-role") {
        const role = requireString(ctx.options, "role");
        const scopes = list("scopes") ?? [];
        if (scopes.length === 0) throw new UserError("`scopes` must list at least one scope.");
        const res = await ctx.api.setRolePermissions(ctx.actor, role, scopes);
        return {
          text: lines([
            `:closed_lock_with_key: **${res.role}** may now: ${code(res.scopes)}`,
            "_Open sessions pick this up within a few seconds — nobody needs to sign in again._",
          ]),
        };
      }

      const id = requireString(ctx.options, "id");
      const grant = list("grant");
      const deny = list("deny");
      if (grant === undefined && deny === undefined) {
        throw new UserError("Pass `grant`, `deny`, or both. To clear all tuning, pass `grant:` and `deny:` empty.");
      }
      // An omitted list means "leave it alone", so read the current state
      // first: a command that only mentions `deny` must not drop the grants.
      const current = await ctx.api.userPermissions(ctx.actor, id);
      const res = await ctx.api.setUserPermissions(ctx.actor, id, {
        extraScopes: grant ?? current.extraScopes,
        deniedScopes: deny ?? current.deniedScopes,
      });
      return {
        text: lines([
          `:closed_lock_with_key: **${current.email}**`,
          `**Granted**: ${code(res.extraScopes)}`,
          `**Denied**: ${code(res.deniedScopes)}`,
          `**Effective**: ${code(res.effective)}`,
        ]),
      };
    },
  },
  {
    name: "access",
    description: "Which guilds, channels, users and roles may operate this bot.",
    /**
     * Editing is `destructive` rather than `mutate` because it hands out
     * authority: whoever is added here can run every mutating command the
     * bot's own token allows. The confirmation is the point.
     */
    sensitivity: { show: "read", add: "destructive", remove: "destructive", reset: "destructive" },
    ephemeral: true,
    builder: new SlashCommandBuilder()
      .setName("access")
      .setDescription("Which guilds, channels, users and roles may operate this bot.")
      .addSubcommand((s) =>
        s.setName("show").setDescription("The allowlists in force, and where they are being read from."),
      )
      .addSubcommand((s) =>
        s
          .setName("add")
          .setDescription("Allow a guild, channel, user or role.")
          .addStringOption((o) =>
            o.setName("list").setDescription("Which allowlist to add to.").setRequired(true).addChoices(...LIST_CHOICES),
          )
          .addStringOption((o) =>
            o
              .setName("id")
              .setDescription("The snowflake, or a #channel / @user / @role mention.")
              .setRequired(true),
          )
          .addStringOption((o) => o.setName("label").setDescription("What to call it on the dashboard."))
          .addBooleanOption((o) =>
            o.setName("confirm").setDescription("Required: this grants control of the platform."),
          ),
      )
      .addSubcommand((s) =>
        s
          .setName("remove")
          .setDescription("Revoke a guild, channel, user or role.")
          .addStringOption((o) =>
            o
              .setName("list")
              .setDescription("Which allowlist to remove from.")
              .setRequired(true)
              .addChoices(...LIST_CHOICES),
          )
          .addStringOption((o) =>
            o.setName("id").setDescription("The snowflake, or a mention.").setRequired(true),
          )
          .addBooleanOption((o) =>
            o.setName("confirm").setDescription("Required: you can lock yourself out with this."),
          ),
      )
      .addSubcommand((s) =>
        s
          .setName("reset")
          .setDescription("Forget the stored lists and fall back to the bot's environment.")
          .addBooleanOption((o) =>
            o.setName("confirm").setDescription("Required: reverts to whatever .env the bot was deployed with."),
          ),
      ),
    async run(ctx) {
      const sub = ctx.options.subcommand() ?? "show";

      if (sub === "show") {
        const view = await ctx.api.botAuthz(ctx.actor);
        const source = view.configured
          ? "the control plane (edit on the dashboard, or here)"
          : "the bot's environment — nothing has been saved yet, so `.env` is still in force";
        const parts = [`**Source**: ${source}`];
        for (const [name, entries] of Object.entries(view.entries) as [AuthzListName, AuthzEntry[]][]) {
          parts.push(`**${LIST_LABELS[name]}** (${entries.length}): ${renderEntries(entries)}`);
        }
        for (const warning of view.warnings) parts.push(`:warning: ${warning}`);
        return { text: lines(parts) };
      }

      if (sub === "reset") {
        if (ctx.options.boolean("confirm") !== true) {
          return {
            text: lines([
              "This discards every stored allowlist and hands control back to the bot's environment.",
              "If `.env` is empty, that means **no admins and no channels**, and every write is refused until you set them again.",
              "Re-issue with `confirm: true` if that is what you want.",
            ]),
          };
        }
        const view = await ctx.api.resetBotAuthz(ctx.actor);
        return {
          text: lines([
            "Stored allowlists cleared; the bot is back on its environment.",
            `**Now in force**: ${describeView(view)}`,
          ]),
        };
      }

      const listName = LIST_BY_CHOICE[ctx.options.string("list") ?? ""];
      if (!listName) return { text: "Pick one of the four lists." };
      const id = snowflakeFrom(ctx.options.string("id"));
      if (!id) {
        return {
          text: lines([
            "That is not a Discord id.",
            "Turn on **Developer Mode** (Settings → Advanced), then right-click the server, channel, user or role and **Copy ID**.",
            "A `#channel`, `@user` or `@role` mention works too; a plain name does not.",
          ]),
        };
      }

      if (ctx.options.boolean("confirm") !== true) {
        const effect =
          sub === "add"
            ? `\`${id}\` will be able to operate this bot within the ${LIST_LABELS[listName]} list.`
            : `\`${id}\` will lose access. If that is your own account or your only admin role, you are locking yourself out.`;
        return { text: lines([effect, "Re-issue with `confirm: true` if that is what you want."]) };
      }

      // Read-modify-write: the API replaces a list wholesale, which is right for
      // a dashboard textarea but not for "add one". Two operators editing the
      // same list in the same second would have one edit win; that is a trade
      // worth taking over inventing a delta endpoint for a four-row table.
      const before = await ctx.api.botAuthz(ctx.actor);
      const existing = before.entries[listName];
      let next: { id: string; label: string }[];
      if (sub === "add") {
        if (existing.some((e) => e.id === id)) {
          return { text: `\`${id}\` is already on the ${LIST_LABELS[listName]} list.` };
        }
        next = [...existing, { id, label: (ctx.options.string("label") ?? "").slice(0, 80) }];
      } else {
        if (!existing.some((e) => e.id === id)) {
          return { text: `\`${id}\` is not on the ${LIST_LABELS[listName]} list; nothing to remove.` };
        }
        next = existing.filter((e) => e.id !== id);
      }

      const after = await ctx.api.setBotAuthz(ctx.actor, { [listName]: next });
      const verb = sub === "add" ? "Added" : "Removed";
      const parts = [
        `${verb} \`${id}\` ${sub === "add" ? "to" : "from"} **${LIST_LABELS[listName]}**.`,
        `**${LIST_LABELS[listName]}** is now: ${renderEntries(after.entries[listName])}`,
        "The bot re-reads its allowlists about once a minute, so this takes effect shortly.",
      ];
      for (const warning of after.warnings) parts.push(`:warning: ${warning}`);
      return { text: lines(parts) };
    },
  },
  {
    name: "whoami",
    description: "What this bot is, where it points, and what its token may do.",
    sensitivity: "read",
    ephemeral: true,
    builder: new SlashCommandBuilder()
      .setName("whoami")
      .setDescription("What this bot is, where it points, and what its token may do."),
    async run(ctx) {
      const parts = [
        `**Core API**: ${ctx.api.baseUrl}`,
        `**Token**: ${ctx.api.tokenFingerprint}`,
        `**Acting as**: \`${ctx.actor}\`. This is what lands in the audit log for your commands.`,
      ];
      if (!ctx.api.looksScoped) {
        parts.push(
          ":warning: This token does not look like a scoped `pa_…` token. If it is the platform's root `ADMIN_TOKEN`, " +
            "the bot can do everything the control plane can, including publishing bundles. See `docs/bot.md`.",
        );
      }
      const identity = await ctx.api.tokenSelf(ctx.actor);
      const scopes = identity?.scopes ?? ctx.api.observedScopes;
      if (scopes && scopes.length > 0) {
        const source = identity?.scopes ? "" : " *(learned from an earlier refused command)*";
        parts.push(`**Scopes**${source}: ${scopes.map((s) => `\`${s}\``).join(", ")}`);
        if (scopes.includes("*")) {
          parts.push(":warning: `*` is every scope; that defeats the point of a scoped token.");
        }
      } else {
        parts.push(
          "**Scopes**: the API has no token-introspection endpoint, so the bot cannot list them up front. " +
            "A command needing a grant the token lacks fails with a 403 that names the missing scope *and* " +
            "the ones it holds; run one and this command will report them afterwards.",
        );
      }
      return { text: lines(parts) };
    },
  },
];

// ---- retired and renamed legacy commands ----------------------------------

interface RetiredCommand {
  name: string;
  /** Why the capability is gone, or where it moved to. */
  replacement: string;
}

/**
 * Legacy commands that still register, so typing the muscle-memory name gets a
 * pointer instead of "unknown command". Every entry matches a row in
 * docs/ipc-to-api-mapping.md → "Retired".
 */
export const RETIRED_COMMANDS: RetiredCommand[] = [
  {
    name: "logs",
    replacement:
      "There is no log API; work runs on machines the core cannot read. For failures use `/errors list`, which merges dead-lettered jobs, failed uploads and quarantines into one list, and `/errors clear` once you have dealt with one. For process output, `docker compose logs -f core-api` on the core host.",
  },
  {
    name: "kill",
    replacement:
      "There is no in-memory queue to drain. Cancel work individually, `/jobs cancel id:<id>` for scrape jobs, `/queue cancel id:<id>` for uploads, or `/pause` the platform to stop new work.",
  },
  {
    name: "restart-workers",
    replacement:
      "Upload workers are separate containers (`docker compose restart core-uploader`) and scrape workers are remote hosts: `/workers drain id:<id>`, restart the agent there, then `/workers activate id:<id>`. In-flight jobs are leased and requeue automatically.",
  },
  {
    name: "config",
    replacement:
      "Configuration is environment- and Docker-secret-driven. Inspect it with `docker compose config` on the core host; nothing that holds a credential is readable or settable over the API, and certainly not from a chat message.",
  },
  {
    name: "login",
    replacement:
      "There is no \"log in now\" operation. `/mdauth clear confirm:true` forgets the stored session, and the next MangaDex call authenticates from the configured credentials; same outcome, without a command that holds a password.",
  },
  {
    name: "logout",
    replacement:
      "Use `/mdauth clear confirm:true` to forget the stored session. It does not revoke anything MangaDex-side; that is a credential rotation, see `docs/operations.md`.",
  },
  {
    name: "pull",
    replacement:
      "Nothing overwrites a running deployment's source any more. Build bundles in CI and publish them: `publoader-admin bundle publish <dir> --source-commit <sha>`.",
  },
  {
    name: "reload",
    replacement:
      "There is no in-process module tree to reload; extension code is fetched per job as a sha256-pinned bundle. Publish a new bundle and the next job picks it up.",
  },
  {
    name: "restart",
    replacement:
      "A container must not rewrite and re-exec itself. Redeploy on the core host: `docker compose pull && docker compose up -d`.",
  },
  {
    name: "refresh",
    replacement:
      "This was `pull` plus `reload`, and both are gone. Publish a new bundle instead; see `/pull` and `/reload`.",
  },
  {
    name: "shutdown",
    replacement:
      "The bot has no Docker socket by design, so it cannot stop the platform. Use `/pause` to stop work, or `docker compose stop` on the core host.",
  },
  {
    name: "load",
    replacement: "Renamed: use `/extensions enable extension:<name>`.",
  },
  {
    name: "unload",
    replacement: "Renamed: use `/extensions disable extension:<name>`.",
  },
  {
    name: "force",
    replacement: "Folded into `/run`: use `/run extension:<name> mode:FORCE`.",
  },
  {
    name: "clean",
    replacement: "Folded into `/run`: use `/run extension:<name> mode:CLEAN confirm:true`.",
  },
  {
    name: "history",
    replacement: "Renamed: use `/runs recent` (optionally with `extension:`).",
  },
  {
    name: "removal",
    replacement: "Renamed: use `/removal-mode get` and `/removal-mode set mode:<mode>`.",
  },
];

function retiredCommand(retired: RetiredCommand): BotCommand {
  const description = `Retired legacy command; tells you what replaced it.`;
  return {
    name: retired.name,
    description,
    sensitivity: "read",
    ephemeral: true,
    builder: new SlashCommandBuilder().setName(retired.name).setDescription(description),
    async run() {
      return { text: `:no_entry_sign: **\`/${retired.name}\` is retired.**\n${retired.replacement}` };
    },
  };
}

/** Every command the bot registers, real and retired. */
export const ALL_COMMANDS: BotCommand[] = [...commands, ...RETIRED_COMMANDS.map(retiredCommand)];

export const COMMANDS_BY_NAME: ReadonlyMap<string, BotCommand> = new Map(
  ALL_COMMANDS.map((c) => [c.name, c]),
);

/**
 * Run a handler and turn any failure into a reply. Handlers are allowed to
 * throw; nothing reaches Discord as an unhandled rejection, and an operator
 * always gets a next step rather than silence.
 */
export async function runCommand(command: BotCommand, ctx: HandlerContext): Promise<BotReply> {
  try {
    return await command.run(ctx);
  } catch (err) {
    if (err instanceof UserError) return { text: `:x: ${err.message}` };
    ctx.log.warn({ err, command: command.name }, "command failed");
    return { text: `:x: \`/${command.name}\` failed.\n${describeApiError(err)}` };
  }
}

function formatSchedule(entry: {
  hour: number;
  minute: number;
  days: number[];
  kind: string;
  label?: string;
  enabled?: boolean;
}): string {
  const time = `${String(entry.hour).padStart(2, "0")}:${String(entry.minute).padStart(2, "0")} UTC`;
  const when =
    entry.days.length === 0
      ? "daily"
      : entry.days.map((d) => WEEKDAY_ABBREVIATIONS[d] ?? `day ${d}`).join("/");
  const off = entry.enabled === false ? " *(off)*" : "";
  const note = entry.label ? `, ${entry.label}` : "";
  return `${time} ${when} \`${entry.kind.toLowerCase()}\`${off}${note}`;
}

function runIcon(state: string): string {
  switch (state) {
    case "PROCESSED":
    case "COMPLETED":
      return ":green_circle:";
    case "FAILED":
    case "DEAD_LETTER":
      return ":red_circle:";
    case "CANCELLED":
      return ":black_circle:";
    default:
      return ":hourglass:";
  }
}

function workerIcon(status: string): string {
  switch (status) {
    case "ACTIVE":
      return ":green_circle:";
    case "DRAINED":
      return ":yellow_circle:";
    case "REVOKED":
      return ":red_circle:";
    default:
      return ":white_circle:";
  }
}
