/**
 * The Discord transport: gateway connection, slash-command registration, and
 * the mapping from an interaction to a handler in commands.ts.
 *
 * Everything policy-shaped lives elsewhere on purpose; authz.ts decides who
 * may act, commands.ts decides what happens, apiClient.ts talks to the control
 * plane. This file only moves data between discord.js and those three.
 */
import {
  ActionRowBuilder,
  Client,
  DiscordjsErrorCodes,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type Message,
  type ModalSubmitInteraction,
} from "discord.js";
import {
  AdminApiError,
  describeApiError,
  type AdminApiClient,
  type TrackedEntry,
} from "./apiClient.js";
import { authorize, describeAuthz, hasAdminAllowlist, isAdmin, type AuthzConfig, type Invoker } from "./authz.js";
import type { AuthzSource } from "./authzSource.js";
import {
  ALL_COMMANDS,
  COMMANDS_BY_NAME,
  resolveSensitivity,
  runCommand,
  scopeChecker,
  type BotCommand,
  type BotReply,
  type OptionReader,
  type ReplyTone,
} from "./commands.js";
import type { Logger } from "../logging.js";

/**
 * Exit code for "restarting will not help"; a bad token, or a bot the guild
 * rejects. Matches services/worker.ts so a supervisor can tell a config error
 * from a crash. EX_CONFIG from sysexits.h.
 */
export const EX_CONFIG = 78;

/** Extension-name autocomplete is served from this cache, refreshed lazily. */
const EXTENSION_CACHE_TTL_MS = 60_000;

/**
 * Prefix on every modal this bot opens.
 *
 * A modal submission arrives as its own interaction carrying only the custom id
 * it was opened with, so that id is the whole routing table. Namespacing it
 * means a submission from another application in the same guild can never be
 * read as one of ours.
 */
const MODAL_PREFIX = "publoader:";

/** One @mention answer per person per this long, so a loop cannot flood. */
const MENTION_COOLDOWN_MS = 10_000;

/** How long a caller's resolved scopes are reused; see `scopesFor`. */
const SCOPE_CACHE_TTL_MS = 60_000;

/** What `publishToGuilds` did, split by outcome so each can be reported. */
export interface GuildPublishResult {
  registered: string[];
  /** Pinned, but the bot is not in the guild — nothing to publish to. */
  notMember: string[];
  failed: { guildId: string; err: unknown }[];
}

/**
 * Publish the command set to each pinned guild, independently.
 *
 * Extracted from the bot so the property that matters is testable without a
 * gateway connection: **one bad guild must not cost the others their
 * commands**. Sharing a single try/catch across the loop meant that pinning a
 * guild the bot had not been invited to — the natural order to do those two
 * things in — threw on the first call and left every guild without commands,
 * including the ones that had been working for months.
 */
export async function publishToGuilds(
  guildIds: readonly string[],
  io: { isMember(guildId: string): boolean; publish(guildId: string): Promise<void> },
): Promise<GuildPublishResult> {
  const result: GuildPublishResult = { registered: [], notMember: [], failed: [] };
  for (const guildId of guildIds) {
    if (!io.isMember(guildId)) {
      result.notMember.push(guildId);
      continue;
    }
    try {
      await io.publish(guildId);
      result.registered.push(guildId);
    } catch (err) {
      result.failed.push({ guildId, err });
    }
  }
  return result;
}

/** Everything the mention reply reports on, resolved from the live config. */
export interface MentionFacts {
  anyGuildPinned: boolean;
  guildPinned: boolean;
  anyChannelConfigured: boolean;
  channelAllowed: boolean;
  adminsConfigured: boolean;
  isAdmin: boolean;
}

/**
 * The answer to "why isn't this working here?", in plain sentences.
 *
 * Exists because the gating is invisible from inside Discord: when a command is
 * missing there is nothing to run to find out why, the bot's logs do not reach
 * the control plane, and the dashboard cannot see which guilds the bot is
 * actually in. An @mention needs no slash command to be registered and no
 * permission beyond posting, so it still works in exactly the situations where
 * everything else has failed.
 *
 * Deliberately carries no snowflakes. It tells you about the server, channel
 * and account you are already standing in, so it can be answered to anyone who
 * asks without handing out the shape of the deployment.
 */
export function mentionReport(facts: MentionFacts): string {
  const lines = ["**publoader bot** — online."];

  if (!facts.anyGuildPinned) {
    lines.push(
      "• **Server**: no guild is pinned, so commands are registered globally and can take up to an hour to appear.",
    );
  } else if (facts.guildPinned) {
    lines.push("• **Server**: pinned. Slash commands should be registered here.");
  } else {
    lines.push(
      "• **Server**: :x: this server is **not** on the bot's guild list. It has no slash commands here, and any command would be refused. Add it on the dashboard under Permissions → Discord bot access.",
    );
  }

  if (!facts.anyChannelConfigured) {
    lines.push(
      "• **Channel**: no allowed channels are configured, so read-only commands work anywhere and every state-changing command is refused.",
    );
  } else if (facts.channelAllowed) {
    lines.push("• **Channel**: allowed.");
  } else {
    lines.push(
      "• **Channel**: :x: not on the allowed-channel list, so commands here are refused. A thread counts as its parent channel.",
    );
  }

  if (!facts.adminsConfigured) {
    lines.push(
      "• **You**: no admins are configured at all, so every state-changing command is refused for everyone.",
    );
  } else if (facts.isAdmin) {
    lines.push("• **You**: a platform admin. You can run every command.");
  } else {
    lines.push("• **You**: not an admin, so you can run the read-only commands only.");
  }

  return lines.join("\n");
}

/**
 * Colours, chosen once so a reply's tone is not forty-seven separate opinions.
 *
 * Muted rather than saturated: these sit in an operations channel next to log
 * lines, and a control-plane bot shouting in primary colours reads as a toy.
 * The palette matches the dashboard's, so the two surfaces look related.
 */
const TONE_COLOUR: Record<ReplyTone, number> = {
  ok: 0x3f9d5a,
  info: 0x4a6fa5,
  warn: 0xb8860b,
  error: 0xa63d40,
  denied: 0x6b6f76,
};

const TONE_MARK: Record<ReplyTone, string> = {
  ok: "✓",
  info: "•",
  warn: "!",
  error: "✕",
  denied: "🔒",
};

/**
 * Read a reply's tone off the marker it already starts with, and drop it.
 *
 * Forty-seven handlers had settled on `:x:`, `:warning:` and friends long
 * before any of this was an embed. Inferring from that is what let every one of
 * them gain a colour without being edited — and a handler that cares can still
 * say `tone` explicitly, which wins.
 *
 * The marker is stripped once inferred: the embed's own mark and colour already
 * say it, and two of them in a row reads as a stutter.
 */
export function inferTone(text: string): { tone: ReplyTone; text: string } {
  const markers: [RegExp, ReplyTone][] = [
    [/^:(?:x|rotating_light|bangbang):\s*/, "error"],
    [/^:warning:\s*/, "warn"],
    [/^:lock:\s*/, "denied"],
    [/^:(?:white_check_mark|green_circle|heavy_check_mark):\s*/, "ok"],
  ];
  for (const [pattern, tone] of markers) {
    if (pattern.test(text)) return { tone, text: text.replace(pattern, "") };
  }
  return { tone: "info", text };
}

/** Discord's cap on an embed description; the reason replies can be roomy. */
const EMBED_DESCRIPTION_LIMIT = 4096;
const EMBED_FIELD_LIMIT = 1024;

/**
 * Turn a handler's reply into the embed that is actually sent.
 *
 * One place decides presentation. A handler says what happened and, at most,
 * how it went; it never picks a colour, a title or a layout, so the surface
 * stays coherent as commands are added by different hands on different days.
 */
export function buildReplyEmbed(commandName: string, reply: BotReply): EmbedBuilder {
  const inferred = inferTone(reply.text);
  const tone: ReplyTone = reply.tone ?? inferred.tone;
  const embed = new EmbedBuilder()
    .setColor(TONE_COLOUR[tone])
    .setTitle(`${TONE_MARK[tone]} ${reply.title ?? `/${commandName}`}`.slice(0, 256));

  const description = (reply.tone ? reply.text : inferred.text).trim();
  if (description) embed.setDescription(description.slice(0, EMBED_DESCRIPTION_LIMIT));

  // Discord silently drops an embed with more than 25 fields, which would lose
  // the reply rather than shorten it.
  for (const field of (reply.fields ?? []).slice(0, 25)) {
    embed.addFields({
      name: field.name.slice(0, 256),
      value: (field.value || "—").slice(0, EMBED_FIELD_LIMIT),
      inline: field.inline ?? false,
    });
  }
  if (reply.footer) embed.setFooter({ text: reply.footer.slice(0, 2048) });
  return embed;
}

/** The same treatment for a failure, so errors do not arrive as bare text. */
export function buildErrorEmbed(commandName: string, detail: string): EmbedBuilder {
  return buildReplyEmbed(commandName, {
    text: detail,
    title: `/${commandName} failed`,
    tone: "error",
  });
}

export class FatalBotConfigError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FatalBotConfigError";
  }
}

export interface PubloaderBotOptions {
  discordToken: string;
  api: AdminApiClient;
  /** Live allowlists; re-read on a timer so dashboard edits take effect. */
  authz: AuthzSource;
  log: Logger;
}

export class PubloaderBot {
  private readonly client: Client;
  private readonly api: AdminApiClient;
  private readonly authzSource: AuthzSource;
  private readonly log: Logger;
  private readonly discordToken: string;
  /**
   * Users with a command currently executing. A slash command that takes ten
   * seconds is easy to double-submit, and `/run` twice is two runs; the
   * idempotency key only collapses retries of the *same* interaction.
   */
  private readonly inFlight = new Set<string>();
  /** Last @mention answered per user id; see `onMention`. */
  private readonly mentionCooldown = new Map<string, number>();
  /** Per-caller scope sets, for tailoring replies; see `scopesFor`. */
  private readonly scopeCache = new Map<string, { scopes: readonly string[]; fetchedAt: number }>();
  private extensionCache: { names: string[]; fetchedAt: number } | null = null;
  /**
   * One extension's series map, for the `manga-id` and `catalogue`
   * suggestions.
   *
   * Cached because those fire on every keystroke and the endpoint returns the
   * whole map, which for a large extension is thousands of rows; the filtering
   * is local anyway, so re-reading it per character buys nothing. A minute
   * stale is the right trade here: a mapping added seconds ago is one an
   * operator already knows the id of.
   */
  private readonly trackedCache = new Map<string, { rows: TrackedEntry[]; namespaces: string[]; fetchedAt: number }>();
  private shuttingDown = false;

  /**
   * The allowlists in force *right now*.
   *
   * A getter rather than a field because the source re-reads them on a timer:
   * caching the config would mean an operator's dashboard edit did nothing
   * until the bot was restarted, which is the problem this replaced.
   */
  private get authz(): AuthzConfig {
    return this.authzSource.config;
  }

  constructor(opts: PubloaderBotOptions) {
    this.api = opts.api;
    this.authzSource = opts.authz;
    this.log = opts.log;
    this.discordToken = opts.discordToken;
    // GuildMessages is here only so an @mention can be answered; see
    // `onMention`. It is NOT privileged, and MessageContent deliberately is not
    // requested, so every message this bot receives has an empty `content` and
    // it still cannot see what people type. What it can see is that a message
    // happened and whether it was mentioned in it, which is all the mention
    // handler reads.
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
    });

    this.client.once(Events.ClientReady, (client) => {
      this.log.info(
        { user: client.user.tag, guilds: client.guilds.cache.size },
        "discord bot connected",
      );
      void this.registerCommands();
    });
    this.client.on(Events.InteractionCreate, (interaction) => {
      void this.onInteraction(interaction);
    });
    this.client.on(Events.MessageCreate, (message) => {
      void this.onMention(message);
    });
    this.client.on(Events.Error, (err) => {
      this.log.error({ err }, "discord client error");
    });
  }

  /**
   * Prove the API credential works before connecting to Discord.
   *
   * Failing here means the bot never appears online, which is a much clearer
   * signal than a bot that responds to every command with a 401.
   */
  async selfCheck(): Promise<void> {
    if (!this.api.looksScoped) {
      this.log.warn(
        { token: this.api.tokenFingerprint },
        "BOT_API_TOKEN does not look like a scoped pa_ token; if this is the root ADMIN_TOKEN the bot holds full control-plane authority, including bundle publishing",
      );
    }
    try {
      const stats = await this.api.stats("discord:startup-self-check");
      this.log.info(
        { coreUrl: this.api.baseUrl, paused: stats.paused, authz: describeAuthz(this.authz) },
        "admin API reachable; bot authorization model loaded",
      );
    } catch (err) {
      if (err instanceof AdminApiError && err.status === 401) {
        throw new FatalBotConfigError(
          `the core API rejected BOT_API_TOKEN (401: ${err.detail}). ` +
            "Mint a token for the bot and set BOT_API_TOKEN; the bot cannot work without one.",
          { cause: err },
        );
      }
      if (err instanceof AdminApiError && err.status === 403) {
        // The token is valid, it just cannot read stats. Every other command
        // may still work, so refusing to start would be an overreaction; and
        // the 403 body has already told the client which scopes it holds.
        this.log.warn(
          { held: err.held, missing: err.scope },
          "BOT_API_TOKEN is accepted but lacks stats:read, so /status and /ping will fail; add the scope if you want them",
        );
        return;
      }
      // Anything else (core down, DNS, 503) is transient: log loudly and start
      // anyway so the bot is online to report the outage rather than absent
      // during it.
      this.log.error(
        { err, coreUrl: this.api.baseUrl },
        "startup self-check could not reach the admin API, starting anyway; commands will report the failure",
      );
    }
  }

  async start(): Promise<void> {
    await this.selfCheck();
    // Read the stored allowlists before connecting, so the very first
    // interaction is judged against the current config rather than against the
    // environment the container happened to be started with.
    await this.authzSource.refresh();
    this.authzSource.start(({ guildsChanged }) => {
      if (guildsChanged) void this.registerCommands();
    });
    try {
      await this.client.login(this.discordToken);
    } catch (err) {
      // Discord rejecting the credential, or refusing the intents, is a config
      // error dressed as a runtime one. Translating it here is what turns an
      // opaque restart loop into one line naming the fix; the legacy bot had
      // to hand-write this advice for the same two failures.
      throw translateLoginError(err);
    }
  }

  async stop(reason: string): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.log.info({ reason }, "shutting down discord bot");
    this.authzSource.stop();
    await this.client.destroy();
  }

  /**
   * Push the command definitions to Discord.
   *
   * Guild-scoped whenever any guild is pinned: guild commands appear instantly,
   * while global commands can take an hour to propagate; and a control-plane
   * bot has no business exposing its commands in guilds it was not deployed for.
   *
   * Called again whenever the pinned guilds change, because a guild added on
   * the dashboard has no commands in it until this runs — and because a guild
   * *removed* keeps its copy until they are withdrawn.
   */
  private async registerCommands(): Promise<void> {
    const body = ALL_COMMANDS.map((c) => c.builder.toJSON());
    try {
      const guildIds = [...this.authz.guildIds];
      if (guildIds.length > 0) {
        // Each guild is registered on its own. Sharing one try/catch across the
        // loop meant a single unreachable guild — pinned by id on the dashboard
        // before the bot was ever invited to it, which is the natural order to
        // do those two things in — threw on the first call and left *every*
        // guild without commands, including ones that had been working. One bad
        // id must not be able to take the bot down everywhere.
        const { registered, notMember, failed } = await publishToGuilds(guildIds, {
          isMember: (guildId) => this.client.guilds.cache.has(guildId),
          publish: async (guildId) => {
            await this.client.application?.commands.set(body, guildId);
          },
        });
        for (const guildId of notMember) {
          // Worth naming as its own case: Discord answers an unknown guild with
          // a bare 404, and "pinned but never invited" is the one cause an
          // operator can act on without reading a stack trace.
          this.log.warn(
            { guildId },
            "cannot register commands: this guild is pinned but the bot is not a member of it. Invite the bot there with the `bot` and `applications.commands` scopes, or un-pin the guild",
          );
        }
        for (const { guildId, err } of failed) {
          this.log.error(
            { err, guildId },
            "failed to register slash commands in this guild; the other pinned guilds are unaffected. The usual cause is an invite that omitted the `applications.commands` scope",
          );
        }
        if (registered.length > 0) {
          this.log.info({ count: body.length, guildIds: registered }, "registered guild slash commands");
        } else {
          this.log.error(
            { guildIds },
            "no pinned guild accepted the command set; the bot has no slash commands anywhere",
          );
        }
      } else {
        await this.client.application?.commands.set(body);
        this.log.warn(
          { count: body.length },
          "registered GLOBAL slash commands because no guild is pinned; propagation is slow and the commands appear in every guild the bot joins. Pin one on the dashboard's Permissions page or with DISCORD_GUILD_ID",
        );
      }
      await this.withdrawStaleGuildCommands(this.authz.guildIds);
    } catch (err) {
      this.log.error({ err }, "failed to register slash commands");
    }
  }

  /**
   * Clear guild-scoped commands from every joined guild that should not have
   * them: the ones just de-listed, and *all* of them when the bot has fallen
   * back to global registration.
   *
   * Discord keeps a guild's command set and the application's global set in
   * separate places and shows the union of the two. So un-pinning a guild
   * without clearing it does not move the commands, it duplicates them — every
   * entry appears twice in that guild's picker, one copy guild-scoped and one
   * global. De-listing a guild without clearing is worse: the full menu stays
   * on screen in a server where every entry now answers "wrong guild".
   *
   * Driven off `client.guilds.cache` rather than a record of what this process
   * registered, because the interesting case is a bot that was *restarted* with
   * a changed config, and a field on this instance knows nothing about what the
   * previous one did.
   */
  private async withdrawStaleGuildCommands(keep: ReadonlySet<string>): Promise<void> {
    const application = this.client.application;
    if (!application) return;
    for (const guildId of this.client.guilds.cache.keys()) {
      if (keep.has(guildId)) continue;
      try {
        // Fetch first so the common case — nothing to clear, every restart
        // after the first — costs a read instead of a pointless write.
        const existing = await application.commands.fetch({ guildId });
        if (existing.size === 0) continue;
        await application.commands.set([], guildId);
        this.log.info({ guildId, count: existing.size }, "withdrew stale guild slash commands");
      } catch (err) {
        // Missing `applications.commands` in this guild's invite is the usual
        // cause, and it means there is nothing registered there to withdraw.
        this.log.warn({ err, guildId }, "could not check or withdraw this guild's slash commands");
      }
    }
  }

  /**
   * Answer an @mention with why the bot is, or is not, usable right here.
   *
   * The escape hatch for the failure this bot is worst at explaining: no slash
   * commands. When registration has failed there is nothing to type, the bot's
   * logs stay on its own host, and the dashboard cannot tell which guilds the
   * bot is actually in. A mention needs none of that machinery.
   *
   * It is deliberately *not* gated by `authorize`. Gating it would mean the one
   * diagnostic that works when the gates are misconfigured stops working
   * exactly when the gates are misconfigured. The reply is safe to hand to
   * anyone: it names no ids, and every fact in it is about the server, channel
   * and account the asker is already in.
   */
  private async onMention(message: Message): Promise<void> {
    if (!this.client.user || message.author.bot) return;
    // Only a direct mention of this bot. `mentions.users` excludes @everyone
    // and @here, so the bot cannot be made to reply to a mass ping.
    if (!message.mentions.users.has(this.client.user.id)) return;

    // One reply per user per ten seconds, so a mention loop cannot turn the bot
    // into a flood. Keyed by user rather than channel: two people asking at
    // once are both entitled to an answer.
    const now = Date.now();
    const last = this.mentionCooldown.get(message.author.id) ?? 0;
    if (now - last < MENTION_COOLDOWN_MS) return;
    this.mentionCooldown.set(message.author.id, now);

    const config = this.authz;
    const parentChannelId = parentIdOfChannel(message.channel);
    const channelAllowed =
      config.allowedChannelIds.has(message.channelId) ||
      (parentChannelId !== null && config.allowedChannelIds.has(parentChannelId));

    const report = mentionReport({
      anyGuildPinned: config.guildIds.size > 0,
      guildPinned: message.guildId !== null && config.guildIds.has(message.guildId),
      anyChannelConfigured: config.allowedChannelIds.size > 0,
      channelAllowed,
      adminsConfigured: hasAdminAllowlist(config),
      isAdmin: isAdmin(config, {
        userId: message.author.id,
        roleIds: roleIdsOf(message.member),
        channelId: message.channelId,
      }),
    });

    try {
      await message.reply(report);
    } catch (err) {
      // Almost always "Missing Permissions": unlike an interaction reply, this
      // is an ordinary message and needs Send Messages in this channel. Nothing
      // to do about it from here, but it should not be silent.
      this.log.warn(
        { err, guildId: message.guildId, channelId: message.channelId },
        "could not answer an @mention; the bot likely lacks Send Messages in that channel",
      );
    }
  }

  /**
   * The API client a command should run through.
   *
   * In `dashboard` mode every call carries the caller's Discord id, and the
   * control plane runs it with that person's own operator scopes intersected
   * with the bot token's. So a read-only account is read-only here too, and the
   * bot stops being a single shared identity that everyone borrows.
   *
   * In `allowlist` mode nothing is sent and the bot acts as itself, which is
   * what a deployment that has not linked its operators to Discord accounts
   * needs — naming a person there would refuse every command.
   */
  private apiFor(discordUserId: string): AdminApiClient {
    return this.authzSource.mode === "dashboard" ? this.api.onBehalfOf(discordUserId) : this.api;
  }

  /**
   * What the person running this command may do, for shaping the reply.
   *
   * One introspection call per person per minute, not one per command: a reply
   * that leaves out sections is a presentation decision, and paying a round
   * trip for it on every keystroke of autocomplete would be absurd. A minute
   * stale is harmless here because it never grants anything — the API still
   * authorizes every call independently, so the worst a stale answer does is
   * render a section that the subsequent request then refuses.
   *
   * Undefined on failure, which `scopeChecker` reads as "show everything".
   */
  private async scopesFor(discordUserId: string, actor: string): Promise<readonly string[] | undefined> {
    const cached = this.scopeCache.get(discordUserId);
    if (cached && Date.now() - cached.fetchedAt < SCOPE_CACHE_TTL_MS) return cached.scopes;
    try {
      const identity = await this.apiFor(discordUserId).tokenSelf(actor);
      const scopes = identity?.scopes;
      if (!scopes) return undefined;
      this.scopeCache.set(discordUserId, { scopes, fetchedAt: Date.now() });
      return scopes;
    } catch (err) {
      // Never fatal: the command itself is still authorized server-side, so a
      // failure here costs a tailored reply and nothing else.
      this.log.debug({ err }, "could not resolve caller scopes; replying in full");
      return undefined;
    }
  }

  private async onInteraction(interaction: Interaction): Promise<void> {
    if (interaction.isAutocomplete()) {
      await this.onAutocomplete(interaction);
      return;
    }
    if (interaction.isModalSubmit()) {
      await this.onModalSubmit(interaction);
      return;
    }
    if (!interaction.isChatInputCommand()) return;
    await this.onCommand(interaction);
  }

  private async onCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const command = COMMANDS_BY_NAME.get(interaction.commandName);
    if (!command) {
      // Registration drift: a command Discord still knows about but this build
      // does not. Say so rather than time out.
      await interaction
        .reply({
          content: `:x: \`/${interaction.commandName}\` is not implemented by this build of the bot.`,
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => undefined);
      return;
    }

    const invoker = await invokerOf(interaction);
    const subcommand = interaction.options.getSubcommand(false);
    const sensitivity = resolveSensitivity(command, subcommand);
    const decision = authorize(this.authz, invoker, sensitivity);
    const log = this.log.child({
      command: command.name,
      subcommand,
      userId: invoker.userId,
      channelId: invoker.channelId,
    });

    if (!decision.allowed) {
      // Denials are always ephemeral and always logged: the log is the only
      // place a pattern of attempts is visible.
      log.warn({ sensitivity, reason: decision.reason }, "command denied");
      await interaction
        .reply({
          embeds: [
            buildReplyEmbed(command.name, {
              text: decision.reason,
              title: "Not allowed here",
              tone: "denied",
            }),
          ],
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => undefined);
      return;
    }

    // A command that opens a modal answers WITH the modal, which has to be the
    // first response to the interaction — so this returns before the deferral
    // below. The work happens on the submission, which is its own interaction.
    if (command.modal) {
      log.info({ sensitivity }, "opening modal");
      await interaction.showModal(buildModal(command)).catch((err: unknown) => {
        log.error({ err }, "could not open the modal");
      });
      return;
    }

    if (this.inFlight.has(invoker.userId)) {
      await interaction
        .reply({
          content: ":hourglass: You already have a command running. Wait for it to finish.",
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => undefined);
      return;
    }
    this.inFlight.add(invoker.userId);

    const actor = actorFor(interaction.user.username);
    try {
      // Admin API calls routinely exceed Discord's 3s interaction window.
      await interaction.deferReply(command.ephemeral ? { flags: MessageFlags.Ephemeral } : {});
      log.info({ sensitivity, actor }, "command accepted");
      const scopes = await this.scopesFor(interaction.user.id, actor);
      const reply = await runCommand(command, {
        api: this.apiFor(interaction.user.id),
        scopes,
        can: scopeChecker(scopes),
        actor,
        options: optionReaderOf(interaction),
        log,
        interactionId: interaction.id,
      });

      if (reply.dm) {
        // A DM can fail for reasons the invoker controls (DMs closed). Falling
        // back to the ephemeral reply is better than losing a minted credential,
        // and the reply is still visible only to them.
        try {
          await interaction.user.send(reply.dm);
        } catch (err) {
          log.warn({ err }, "could not DM secret material to the invoker");
          await interaction.followUp({
            content:
              ":warning: I could not DM you (are DMs from server members closed?). Here it is instead; only you can see this message:\n" +
              reply.dm,
            flags: MessageFlags.Ephemeral,
          });
        }
      }
      await interaction.editReply({ embeds: [buildReplyEmbed(command.name, reply)] });
    } catch (err) {
      log.error({ err }, "interaction handling failed");
      const embed = buildErrorEmbed(command.name, describeApiError(err));
      await (interaction.deferred || interaction.replied
        ? interaction.editReply({ embeds: [embed] })
        : interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral })
      ).catch(() => undefined);
    } finally {
      this.inFlight.delete(invoker.userId);
    }
  }

  /**
   * A submitted modal: the same command, run against what was typed into it.
   *
   * Authorised again rather than trusting the interaction that opened it. The
   * two are separate interactions, minutes can pass between them, and a role or
   * channel decision can change in between; re-checking costs nothing and means
   * the gate is the same one every other command goes through.
   */
  private async onModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    if (!interaction.customId.startsWith(MODAL_PREFIX)) return;
    const name = interaction.customId.slice(MODAL_PREFIX.length);
    const command = COMMANDS_BY_NAME.get(name);
    if (!command?.modal) return;

    const invoker = await invokerOf(interaction);
    const sensitivity = resolveSensitivity(command, null);
    const decision = authorize(this.authz, invoker, sensitivity);
    const log = this.log.child({ command: command.name, modal: true, userId: invoker.userId });
    if (!decision.allowed) {
      log.warn({ sensitivity, reason: decision.reason }, "modal denied");
      await interaction
        .reply({
          embeds: [
            buildReplyEmbed(command.name, {
              text: decision.reason,
              title: "Not allowed here",
              tone: "denied",
            }),
          ],
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => undefined);
      return;
    }

    if (this.inFlight.has(invoker.userId)) {
      await interaction
        .reply({
          content: ":hourglass: You already have a command running. Wait for it to finish.",
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => undefined);
      return;
    }
    this.inFlight.add(invoker.userId);

    const actor = actorFor(interaction.user.username);
    try {
      await interaction.deferReply(command.ephemeral ? { flags: MessageFlags.Ephemeral } : {});
      log.info({ sensitivity, actor }, "modal accepted");
      const scopes = await this.scopesFor(interaction.user.id, actor);
      const reply = await runCommand(command, {
        api: this.apiFor(interaction.user.id),
        scopes,
        can: scopeChecker(scopes),
        actor,
        options: modalOptionReader(interaction),
        log,
        interactionId: interaction.id,
      });
      await interaction.editReply({ embeds: [buildReplyEmbed(command.name, reply)] });
    } catch (err) {
      log.error({ err }, "modal handling failed");
      const embed = buildErrorEmbed(command.name, describeApiError(err));
      await (interaction.deferred || interaction.replied
        ? interaction.editReply({ embeds: [embed] })
        : interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral })
      ).catch(() => undefined);
    } finally {
      this.inFlight.delete(invoker.userId);
    }
  }

  /**
   * Option autocomplete.
   *
   * Extension names come from the published-bundle list, which is the authority
   * now; the legacy bot listed directories on the scheduler's disk, which could
   * offer a name that had never been published. Series come from the archive
   * itself, uncached: the set changes every time the uploader archives a
   * chapter, and a stale title list is a re-card aimed at the wrong id.
   */
  private async onAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const invoker = await invokerOf(interaction);
    // Gate at the read level: autocomplete in a channel the bot ignores should
    // not enumerate the platform's extensions.
    if (!authorize(this.authz, invoker, "read").allowed) {
      await interaction.respond([]).catch(() => undefined);
      return;
    }
    const focused = interaction.options.getFocused(true);
    const needle = String(focused.value ?? "");
    if (focused.name === "series") {
      await this.respondWithSeries(interaction, needle);
      return;
    }
    if (focused.name === "manga-id") {
      await this.respondWithMangaIds(interaction, needle);
      return;
    }
    if (focused.name === "catalogue") {
      await this.respondWithCatalogues(interaction, needle);
      return;
    }
    if (focused.name === "service") {
      await this.respondWithLogServices(interaction, needle);
      return;
    }
    // `id` is a row id on several commands; only the untracked queue can offer
    // suggestions for one, and answering the others from it would be wrong.
    if (focused.name === "id" && interaction.commandName === "untracked") {
      await this.respondWithUntracked(interaction, needle);
      return;
    }
    if (focused.name !== "extension") {
      await interaction.respond([]).catch(() => undefined);
      return;
    }
    let names: string[] = [];
    try {
      names = await this.extensionNames();
    } catch (err) {
      this.log.debug({ err }, "autocomplete could not list extensions");
    }
    const lowered = needle.toLowerCase();
    const choices = names
      .filter((n) => !lowered || n.toLowerCase().includes(lowered))
      .slice(0, 25)
      .map((n) => ({ name: n, value: n }));
    await interaction.respond(choices).catch(() => undefined);
  }

  /**
   * Titles in the unavailable archive, largest first, as autocomplete choices.
   *
   * The value is the MangaDex id and the label carries the count, because the
   * two things an operator needs to see before choosing are which title it is
   * and how many pages a re-card would move. Failure answers an empty list: a
   * missing suggestion is a worse UX, a thrown autocomplete is a broken one.
   */
  private async respondWithSeries(
    interaction: AutocompleteInteraction,
    needle: string,
  ): Promise<void> {
    let choices: { name: string; value: string }[] = [];
    try {
      const { series } = await this.api.archiveSeries("discord:autocomplete", {
        archive: "unavailable",
        search: needle.trim() || undefined,
        limit: 25,
      });
      choices = series.map((entry) => ({
        // Discord rejects a choice name over 100 characters outright, taking
        // the whole response with it.
        name: `${entry.mangaName ?? entry.mdMangaId} · ${entry.count} card(s)`.slice(0, 100),
        value: entry.mdMangaId,
      }));
    } catch (err) {
      this.log.debug({ err }, "autocomplete could not list series");
    }
    await interaction.respond(choices).catch(() => undefined);
  }

  /**
   * External series ids for the extension already chosen in the same command.
   *
   * WHY IT MATTERS. An extension's ids are whatever the publisher chose —
   * comikey uses slugs, viz uses numbers, mangaplus uses six-digit ids — so
   * mapping from Discord used to begin somewhere else: open the dashboard,
   * find the series, copy the id, come back. These suggestions are the whole
   * difference between "/tracked set" being usable in chat and not.
   *
   * Which set is offered depends on the subcommand, because they are asking
   * different questions. `set` is about a series that is NOT mapped yet, so it
   * offers the untracked queue, searched server-side by name; everything else
   * acts on an existing mapping, so it offers the map itself.
   */
  private async respondWithMangaIds(interaction: AutocompleteInteraction, needle: string): Promise<void> {
    const extension = interaction.options.getString("extension");
    if (!extension) {
      // Nothing to suggest from yet, and saying so beats an empty dropdown
      // that reads as "this extension has no series".
      await interaction
        .respond([{ name: "Choose the extension first, then come back to this box", value: needle.slice(0, 100) }])
        .catch(() => undefined);
      return;
    }
    const query = needle.trim().toLowerCase();
    let choices: { name: string; value: string }[] = [];
    try {
      if (interaction.options.getSubcommand(false) === "set") {
        const { untracked } = await this.api.untracked("discord:autocomplete", {
          limit: 25,
          extension,
          ...(query ? { q: query } : {}),
        });
        choices = untracked
          // A row already mapped is not what `set` is for; it would be a
          // repoint, and those are typed deliberately, not picked off a list.
          .filter((row) => row.state !== "TRACKED")
          .map((row) => ({
            name: `${row.mangaName ?? row.title ?? row.mangaId} · ${row.mangaId}`.slice(0, 100),
            value: row.mangaId.slice(0, 100),
          }));
      } else {
        const { rows } = await this.trackedFor(extension);
        choices = rows
          .filter((row) => !query || row.mangaId.toLowerCase().includes(query))
          .slice(0, 25)
          .map((row) => ({
            name: `${row.namespace ? `${row.namespace}/` : ""}${row.mangaId} → ${row.mdMangaId}`.slice(0, 100),
            value: row.mangaId.slice(0, 100),
          }));
      }
    } catch (err) {
      this.log.debug({ err, extension }, "autocomplete could not list series ids");
    }
    // Whatever has been typed stays choosable: an id that is not in either set
    // is exactly the case a first mapping starts from.
    if (query && !choices.some((c) => c.value === needle)) {
      choices.unshift({ name: `Use “${needle}” as typed`.slice(0, 100), value: needle.slice(0, 100) });
    }
    await interaction.respond(choices.slice(0, 25)).catch(() => undefined);
  }

  /** The catalogues one extension actually has. Empty for all but viz. */
  /**
   * Services that actually appear in the log table.
   *
   * Read from the data rather than hardcoded: the set is whatever has written a
   * line, so a service added later shows up without this file changing, and one
   * that has never logged is not offered as a filter that returns nothing.
   */
  private async respondWithLogServices(interaction: AutocompleteInteraction, needle: string): Promise<void> {
    let choices: { name: string; value: string }[] = [];
    try {
      const { services } = await this.apiFor(interaction.user.id).logSources(actorFor(interaction.user.username));
      const query = needle.trim().toLowerCase();
      choices = services
        .filter((name) => name && (!query || name.toLowerCase().includes(query)))
        .slice(0, 25)
        .map((name) => ({ name, value: name }));
    } catch (err) {
      this.log.debug({ err }, "autocomplete could not list log services");
    }
    await interaction.respond(choices).catch(() => undefined);
  }

  private async respondWithCatalogues(interaction: AutocompleteInteraction, needle: string): Promise<void> {
    const extension = interaction.options.getString("extension");
    let choices: { name: string; value: string }[] = [];
    if (extension) {
      try {
        const { namespaces } = await this.trackedFor(extension);
        const query = needle.trim().toLowerCase();
        choices = namespaces
          .filter((name) => name && (!query || name.toLowerCase().includes(query)))
          .slice(0, 25)
          .map((name) => ({ name, value: name }));
      } catch (err) {
        this.log.debug({ err, extension }, "autocomplete could not list catalogues");
      }
    }
    await interaction.respond(choices).catch(() => undefined);
  }

  /**
   * Rows in the untracked queue, by the name they were reported under.
   *
   * The id is a uuid, so before this the only way to act on a row was to run
   * `/untracked list` and copy one out of its output. The search is done by
   * the API — the queue runs to thousands of rows — and the label carries the
   * extension and state, which is what distinguishes two rows with the same
   * name from two different publishers.
   */
  private async respondWithUntracked(interaction: AutocompleteInteraction, needle: string): Promise<void> {
    let choices: { name: string; value: string }[] = [];
    try {
      const query = needle.trim();
      const { untracked } = await this.api.untracked("discord:autocomplete", {
        limit: 25,
        ...(query ? { q: query } : { state: "NEW" }),
      });
      choices = untracked.map((row) => ({
        name: `${row.mangaName ?? row.title ?? row.mangaId} · ${row.extension} · ${row.state}`.slice(0, 100),
        value: row.id,
      }));
    } catch (err) {
      this.log.debug({ err }, "autocomplete could not list the untracked queue");
    }
    await interaction.respond(choices).catch(() => undefined);
  }

  /** One extension's series map, cached for the length of a few keystrokes. */
  private async trackedFor(extension: string): Promise<{ rows: TrackedEntry[]; namespaces: string[] }> {
    const cached = this.trackedCache.get(extension);
    if (cached && Date.now() - cached.fetchedAt < EXTENSION_CACHE_TTL_MS) return cached;
    const { tracked, namespaces } = await this.api.tracked("discord:autocomplete", extension);
    const entry = { rows: tracked, namespaces: namespaces ?? [], fetchedAt: Date.now() };
    this.trackedCache.set(extension, entry);
    return entry;
  }

  private async extensionNames(): Promise<string[]> {
    const cached = this.extensionCache;
    if (cached && Date.now() - cached.fetchedAt < EXTENSION_CACHE_TTL_MS) return cached.names;
    // Autocomplete must answer within 3s, so this call is short-fused and its
    // failure is non-fatal: an empty list is a worse UX, not a broken bot.
    const { extensions } = await this.api.extensions("discord:autocomplete");
    const names = extensions.map((e) => e.name).sort();
    this.extensionCache = { names, fetchedAt: Date.now() };
    return names;
  }
}

/**
 * Map a discord.js login failure onto a fatal config error where that is what
 * it is. Anything else is passed through untouched; a network blip during
 * login should be retried by the supervisor, not declared unfixable.
 */
export function translateLoginError(err: unknown): unknown {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === DiscordjsErrorCodes.TokenInvalid || code === DiscordjsErrorCodes.TokenMissing) {
    return new FatalBotConfigError(
      "Discord rejected DISCORD_BOT_TOKEN. Copy it from the Developer Portal under Bot → Reset Token; " +
        "the client secret, public key and OAuth token are different values and none of them work here. " +
        "If the token was recently regenerated, the old one is permanently revoked.",
      { cause: err },
    );
  }
  if (code === DiscordjsErrorCodes.DisallowedIntents) {
    return new FatalBotConfigError(
      "Discord refused the requested gateway intents. This bot asks only for Guilds, which is not privileged, " +
        "so this means the application is configured unusually; check Bot → Privileged Gateway Intents.",
      { cause: err },
    );
  }
  return err;
}

/**
 * The modal a command declares, as discord.js wants it.
 *
 * A paragraph field is the only way to paste several lines into Discord: a
 * slash-command option is a single line, and asking an operator to join twenty
 * links with commas is not a paste, it is data entry.
 */
export function buildModal(command: BotCommand): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(`${MODAL_PREFIX}${command.name}`)
    .setTitle(command.modal!.title);
  for (const field of command.modal!.fields) {
    const input = new TextInputBuilder()
      .setCustomId(field.name)
      .setLabel(field.label)
      .setStyle(field.paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(field.required ?? true);
    if (field.placeholder) input.setPlaceholder(field.placeholder);
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  }
  return modal;
}

/**
 * Modal fields, read through the same interface as slash options.
 *
 * Handlers stay transport-free: `/map-many` reads `options.string("pairs")`
 * without knowing whether that came from an option or a text box.
 */
export function modalOptionReader(interaction: ModalSubmitInteraction): OptionReader {
  const read = (name: string): string | null => {
    try {
      return interaction.fields.getTextInputValue(name);
    } catch {
      // An optional field the operator left empty is absent, not an error.
      return null;
    }
  };
  return {
    subcommand: () => null,
    string: read,
    // A modal has text inputs and nothing else; a command needing more than
    // text should take it as a slash option before the modal opens.
    integer: () => null,
    boolean: () => null,
  };
}

/** Adapt discord.js option access to the transport-free reader handlers use. */
function optionReaderOf(interaction: ChatInputCommandInteraction): OptionReader {
  return {
    subcommand: () => interaction.options.getSubcommand(false),
    string: (name) => interaction.options.getString(name),
    integer: (name) => interaction.options.getInteger(name),
    boolean: (name) => interaction.options.getBoolean(name),
  };
}

async function invokerOf(
  interaction: ChatInputCommandInteraction | AutocompleteInteraction | ModalSubmitInteraction,
): Promise<Invoker> {
  return {
    userId: interaction.user.id,
    roleIds: roleIdsOf(interaction.member),
    channelId: interaction.channelId ?? "",
    parentChannelId: await parentChannelIdOf(interaction),
    guildId: interaction.guildId,
  };
}

/**
 * The channel a thread hangs off, or null for anything that is not a thread.
 *
 * Discord reports a thread's own id as the interaction channel, so an operator
 * who allowlisted `#ops` and then opened a thread in it would be refused with
 * "this channel is not on the bot's allowed-channel list" — naming a channel
 * they had in fact allowed. Reading the parent is what makes the allowlist mean
 * the thing the operator wrote down.
 *
 * `interaction.channel` is **cache-only** in discord.js: it is
 * `client.channels.cache.get(channelId) ?? null`, and it does not build a
 * partial from the channel object Discord puts in the interaction payload. A
 * thread that is not cached — the bot lacks `VIEW_CHANNEL` on the parent, or
 * the thread was archived when the gateway last synced — would therefore read
 * as "no parent" and be silently refused, which is the exact bug this exists to
 * fix. So an uncached channel is fetched once; that also seeds the cache, so it
 * costs one call per thread per process rather than one per command.
 */
async function parentChannelIdOf(
  interaction: ChatInputCommandInteraction | AutocompleteInteraction | ModalSubmitInteraction,
): Promise<string | null> {
  let channel: unknown = interaction.channel;
  if (!channel && interaction.channelId) {
    try {
      channel = await interaction.client.channels.fetch(interaction.channelId);
    } catch {
      // Missing access, or a channel that no longer exists. Neither is a
      // parent, and both are correctly answered by the channel allowlist.
      return null;
    }
  }
  return parentIdOfChannel(channel);
}

/**
 * The parent of a channel object, if that channel is a thread.
 *
 * Split from the interaction path because a received message already carries
 * its channel — the gateway delivered it — so the mention handler needs the
 * type check without the fetch.
 */
export function parentIdOfChannel(channel: unknown): string | null {
  if (!channel || typeof channel !== "object") return null;
  const type = (channel as { type?: unknown }).type;
  // AnnouncementThread(10), PublicThread(11), PrivateThread(12). A text
  // channel's `parentId` is its *category*, and honouring that would silently
  // widen a one-channel allowlist to every channel in the category.
  if (type !== 10 && type !== 11 && type !== 12) return null;
  const parentId = (channel as { parentId?: unknown }).parentId;
  return typeof parentId === "string" ? parentId : null;
}

/**
 * Role ids for the invoking member. `interaction.member` is a full GuildMember
 * when the guild is cached and a raw API member (roles as a string array) when
 * it is not, so both shapes have to work; reading only one of them would make
 * role-based admin silently fail on an uncached guild.
 */
function roleIdsOf(member: unknown): string[] {
  if (!member || typeof member !== "object") return [];
  const roles = (member as { roles?: unknown }).roles;
  if (Array.isArray(roles)) return roles.filter((r): r is string => typeof r === "string");
  if (roles && typeof roles === "object" && "cache" in roles) {
    const cache = (roles as { cache: { keys(): Iterable<string> } }).cache;
    return [...cache.keys()];
  }
  return [];
}

/**
 * Build the `x-actor` value from a Discord username.
 *
 * The username is attacker-controlled text going into an HTTP header, so
 * anything that is not plainly safe is stripped rather than escaped: header
 * injection via a crafted display name is not a risk worth being clever about.
 * The server truncates to 64 characters; do it here too so the audit log and
 * the bot agree on what was sent.
 */
export function actorFor(username: string): string {
  const safe = username.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 48);
  return `discord:${safe || "unknown"}`;
}
