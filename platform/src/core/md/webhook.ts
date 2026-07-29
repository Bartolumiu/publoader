import { setTimeout as sleep } from "node:timers/promises";
import type { Config } from "../../config.js";
import type { Logger } from "../../logging.js";

/**
 * Discord notifications — the slice of publoader/webhook.py the upload workers
 * need: build embeds, clip them to Discord's limits, fan them out to every
 * configured URL.
 *
 * Notifications are strictly best-effort. A failing webhook must never fail an
 * upload, so every path here swallows its errors into the log; `send` does not
 * reject.
 */

const DEFAULT_COLOUR = "B86F8C";
const EMBED_TITLE_LIMIT = 256;
const EMBED_DESCRIPTION_LIMIT = 4096;
const EMBED_FIELD_NAME_LIMIT = 256;
const EMBED_FIELD_VALUE_LIMIT = 1024;
const EMBED_FOOTER_TEXT_LIMIT = 2048;
const EMBED_MAX_FIELDS = 25;
/** Discord's 6000-character cap applies across every embed in one message. */
const EMBED_TOTAL_LIMIT = 6000;
const EMBEDS_PER_MESSAGE = 10;
const INTER_MESSAGE_DELAY_MS = 1000;
const REQUEST_TIMEOUT_MS = 15_000;

export interface DiscordField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbedInput {
  title?: string | null;
  description?: string | null;
  /** Hex string ("B86F8C") or a raw integer. Defaults to the publoader pink. */
  colour?: string | number | null;
  footer?: string | null;
  fields?: DiscordField[];
}

interface DiscordEmbedPayload {
  title?: string;
  description?: string;
  color: number;
  footer?: { text: string };
  fields?: DiscordField[];
}

/** Accept one URL, or a comma/newline-separated list (_parse_webhook_urls). */
export function parseWebhookUrls(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\n]/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);
}

function clip(value: string, limit: number): string {
  if (value.length <= limit) return value;
  if (limit <= 0) return "";
  return `${value.slice(0, limit - 1)}…`;
}

function toColour(colour: string | number | null | undefined): number {
  if (typeof colour === "number" && Number.isFinite(colour)) return Math.trunc(colour);
  const hex = (typeof colour === "string" && colour ? colour : DEFAULT_COLOUR).replace(/^#/, "");
  const parsed = Number.parseInt(hex, 16);
  return Number.isNaN(parsed) ? Number.parseInt(DEFAULT_COLOUR, 16) : parsed;
}

function embedLength(embed: DiscordEmbedPayload): number {
  let total = (embed.title?.length ?? 0) + (embed.description?.length ?? 0);
  total += embed.footer?.text.length ?? 0;
  for (const field of embed.fields ?? []) total += field.name.length + field.value.length;
  return total;
}

export class DiscordNotifier {
  private readonly log: Logger;

  constructor(
    private readonly urls: string[],
    log: Logger,
  ) {
    this.log = log.child({ component: "discord" });
  }

  static fromConfig(config: Config, log: Logger): DiscordNotifier {
    return new DiscordNotifier(parseWebhookUrls(config.discordWebhookUrls), log);
  }

  get enabled(): boolean {
    return this.urls.length > 0;
  }

  private static normalise(input: DiscordEmbedInput): DiscordEmbedPayload {
    const embed: DiscordEmbedPayload = { color: toColour(input.colour) };
    if (input.title) embed.title = clip(input.title, EMBED_TITLE_LIMIT);
    if (input.description) embed.description = clip(input.description, EMBED_DESCRIPTION_LIMIT);
    if (input.footer) embed.footer = { text: clip(input.footer, EMBED_FOOTER_TEXT_LIMIT) };
    if (input.fields && input.fields.length > 0) {
      embed.fields = input.fields.slice(0, EMBED_MAX_FIELDS).map((field) => ({
        name: clip(field.name, EMBED_FIELD_NAME_LIMIT),
        value: clip(field.value, EMBED_FIELD_VALUE_LIMIT),
        inline: field.inline ?? true,
      }));
    }
    return embed;
  }

  /**
   * Split embeds into messages that satisfy both the 10-embeds and the
   * 6000-character caps. An embed larger than the total cap on its own still
   * gets its own message — Discord will reject it, but the batch around it
   * still goes out.
   */
  private static batch(embeds: DiscordEmbedPayload[]): DiscordEmbedPayload[][] {
    const batches: DiscordEmbedPayload[][] = [];
    let current: DiscordEmbedPayload[] = [];
    let currentLength = 0;

    for (const embed of embeds) {
      const length = embedLength(embed);
      const wouldOverflow =
        current.length >= EMBEDS_PER_MESSAGE || (current.length > 0 && currentLength + length > EMBED_TOTAL_LIMIT);
      if (wouldOverflow) {
        batches.push(current);
        current = [];
        currentLength = 0;
      }
      current.push(embed);
      currentLength += length;
    }
    if (current.length > 0) batches.push(current);
    return batches;
  }

  /** Post embeds to every configured webhook. Never throws. */
  async send(inputs: DiscordEmbedInput[]): Promise<void> {
    if (this.urls.length === 0 || inputs.length === 0) return;

    const batches = DiscordNotifier.batch(inputs.map(DiscordNotifier.normalise));
    for (const [index, batch] of batches.entries()) {
      for (const url of this.urls) {
        await this.post(url, batch);
      }
      if (index < batches.length - 1) await sleep(INTER_MESSAGE_DELAY_MS);
    }
  }

  private async post(url: string, embeds: DiscordEmbedPayload[]): Promise<void> {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ embeds }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (response.status === 429) {
        const body: unknown = await response.json().catch(() => null);
        const retryAfter =
          body !== null && typeof body === "object" ? (body as { retry_after?: unknown }).retry_after : undefined;
        const waitMs = typeof retryAfter === "number" ? Math.ceil(retryAfter * 1000) : INTER_MESSAGE_DELAY_MS;
        this.log.warn({ waitMs }, "discord ratelimited, retrying once");
        await sleep(waitMs);
        const retry = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ embeds }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!retry.ok) {
          this.log.warn({ status: retry.status }, "discord webhook rejected after retry");
        }
        return;
      }

      if (!response.ok) {
        this.log.warn(
          { status: response.status, body: (await response.text()).slice(0, 500) },
          "discord webhook rejected",
        );
      }
    } catch (err) {
      this.log.warn({ err }, "discord webhook send failed");
    }
  }
}
