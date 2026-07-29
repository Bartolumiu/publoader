/**
 * The Discord transport: gateway connection, slash-command registration, and
 * the mapping from an interaction to a handler in commands.ts.
 *
 * Everything policy-shaped lives elsewhere on purpose — authz.ts decides who
 * may act, commands.ts decides what happens, apiClient.ts talks to the control
 * plane. This file only moves data between discord.js and those three.
 */
import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
} from "discord.js";
import {
  AdminApiError,
  describeApiError,
  type AdminApiClient,
} from "./apiClient.js";
import { authorize, describeAuthz, type AuthzConfig, type Invoker } from "./authz.js";
import {
  ALL_COMMANDS,
  COMMANDS_BY_NAME,
  resolveSensitivity,
  runCommand,
  type OptionReader,
} from "./commands.js";
import type { Logger } from "../logging.js";

/**
 * Exit code for "restarting will not help" — a bad token, or a bot the guild
 * rejects. Matches services/worker.ts so a supervisor can tell a config error
 * from a crash. EX_CONFIG from sysexits.h.
 */
export const EX_CONFIG = 78;

/** Extension-name autocomplete is served from this cache, refreshed lazily. */
const EXTENSION_CACHE_TTL_MS = 60_000;

export class FatalBotConfigError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FatalBotConfigError";
  }
}

export interface PubloaderBotOptions {
  discordToken: string;
  api: AdminApiClient;
  authz: AuthzConfig;
  log: Logger;
}

export class PubloaderBot {
  private readonly client: Client;
  private readonly api: AdminApiClient;
  private readonly authz: AuthzConfig;
  private readonly log: Logger;
  private readonly discordToken: string;
  /**
   * Users with a command currently executing. A slash command that takes ten
   * seconds is easy to double-submit, and `/run` twice is two runs — the
   * idempotency key only collapses retries of the *same* interaction.
   */
  private readonly inFlight = new Set<string>();
  private extensionCache: { names: string[]; fetchedAt: number } | null = null;
  private shuttingDown = false;

  constructor(opts: PubloaderBotOptions) {
    this.api = opts.api;
    this.authz = opts.authz;
    this.log = opts.log;
    this.discordToken = opts.discordToken;
    // Guilds is the only intent needed: the bot is slash-command driven and
    // never reads message content, so it needs no privileged intent and cannot
    // see what people type in channels.
    this.client = new Client({ intents: [GatewayIntentBits.Guilds] });

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
        "BOT_API_TOKEN does not look like a scoped pa_ token — if this is the root ADMIN_TOKEN the bot holds full control-plane authority, including bundle publishing",
      );
    }
    try {
      const stats = await this.api.stats("discord:startup-self-check");
      this.log.info(
        { coreUrl: this.api.baseUrl, paused: stats.paused, authz: describeAuthz(this.authz) },
        "admin API reachable; bot authorization model loaded",
      );
    } catch (err) {
      if (err instanceof AdminApiError && err.isAuth) {
        throw new FatalBotConfigError(
          `the core API rejected BOT_API_TOKEN (${err.status}: ${err.detail}). ` +
            "Mint a token for the bot and set BOT_API_TOKEN; the bot cannot work without one.",
          { cause: err },
        );
      }
      // Anything else (core down, DNS, 503) is transient: log loudly and start
      // anyway so the bot is online to report the outage rather than absent
      // during it.
      this.log.error(
        { err, coreUrl: this.api.baseUrl },
        "startup self-check could not reach the admin API — starting anyway; commands will report the failure",
      );
    }
  }

  async start(): Promise<void> {
    await this.selfCheck();
    await this.client.login(this.discordToken);
  }

  async stop(reason: string): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.log.info({ reason }, "shutting down discord bot");
    await this.client.destroy();
  }

  /**
   * Push the command definitions to Discord.
   *
   * Guild-scoped when DISCORD_GUILD_ID is set: guild commands appear instantly,
   * while global commands can take an hour to propagate — and a control-plane
   * bot has no business exposing its commands in guilds it was not deployed for.
   */
  private async registerCommands(): Promise<void> {
    const body = ALL_COMMANDS.map((c) => c.builder.toJSON());
    try {
      if (this.authz.guildId) {
        await this.client.application?.commands.set(body, this.authz.guildId);
        this.log.info({ count: body.length, guildId: this.authz.guildId }, "registered guild slash commands");
      } else {
        await this.client.application?.commands.set(body);
        this.log.warn(
          { count: body.length },
          "registered GLOBAL slash commands because DISCORD_GUILD_ID is unset — propagation is slow and the commands appear in every guild the bot joins",
        );
      }
    } catch (err) {
      this.log.error({ err }, "failed to register slash commands");
    }
  }

  private async onInteraction(interaction: Interaction): Promise<void> {
    if (interaction.isAutocomplete()) {
      await this.onAutocomplete(interaction);
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

    const invoker = invokerOf(interaction);
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
        .reply({ content: `:lock: ${decision.reason}`, flags: MessageFlags.Ephemeral })
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
      // Admin API calls routinely exceed Discord's 3s interaction window.
      await interaction.deferReply(command.ephemeral ? { flags: MessageFlags.Ephemeral } : {});
      log.info({ sensitivity, actor }, "command accepted");
      const reply = await runCommand(command, {
        api: this.api,
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
              ":warning: I could not DM you (are DMs from server members closed?). Here it is instead — only you can see this message:\n" +
              reply.dm,
            flags: MessageFlags.Ephemeral,
          });
        }
      }
      await interaction.editReply({ content: reply.text });
    } catch (err) {
      log.error({ err }, "interaction handling failed");
      const message = `:x: \`/${command.name}\` failed.\n${describeApiError(err)}`;
      await (interaction.deferred || interaction.replied
        ? interaction.editReply({ content: message })
        : interaction.reply({ content: message, flags: MessageFlags.Ephemeral })
      ).catch(() => undefined);
    } finally {
      this.inFlight.delete(invoker.userId);
    }
  }

  /**
   * Extension-name autocomplete. Backed by the published-bundle list, which is
   * the authority now — the legacy bot listed directories on the scheduler's
   * disk, which could offer a name that had never been published.
   */
  private async onAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const invoker = invokerOf(interaction);
    // Gate at the read level: autocomplete in a channel the bot ignores should
    // not enumerate the platform's extensions.
    if (!authorize(this.authz, invoker, "read").allowed) {
      await interaction.respond([]).catch(() => undefined);
      return;
    }
    const focused = interaction.options.getFocused(true);
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
    const needle = String(focused.value ?? "").toLowerCase();
    const choices = names
      .filter((n) => !needle || n.toLowerCase().includes(needle))
      .slice(0, 25)
      .map((n) => ({ name: n, value: n }));
    await interaction.respond(choices).catch(() => undefined);
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

/** Adapt discord.js option access to the transport-free reader handlers use. */
function optionReaderOf(interaction: ChatInputCommandInteraction): OptionReader {
  return {
    subcommand: () => interaction.options.getSubcommand(false),
    string: (name) => interaction.options.getString(name),
    integer: (name) => interaction.options.getInteger(name),
    boolean: (name) => interaction.options.getBoolean(name),
  };
}

function invokerOf(interaction: ChatInputCommandInteraction | AutocompleteInteraction): Invoker {
  return {
    userId: interaction.user.id,
    roleIds: roleIdsOf(interaction.member),
    channelId: interaction.channelId ?? "",
    guildId: interaction.guildId,
  };
}

/**
 * Role ids for the invoking member. `interaction.member` is a full GuildMember
 * when the guild is cached and a raw API member (roles as a string array) when
 * it is not, so both shapes have to work — reading only one of them would make
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
