import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { adminAuthHook, requireScope } from "../auth.js";
import { sessionAuthenticator, impersonationResolver} from "../session.js";
import { AUTHZ_LISTS, AUTHZ_MODES, entriesToIdLists, normaliseEntries, rejectedIds } from "../../store/botAuthz.js";
import type { AuthzEntries, AuthzEntry, AuthzListName, AuthzMode } from "../../store/botAuthz.js";

/**
 * Who the Discord bot takes orders from: which guilds, which channels, which
 * users and roles may make it change things.
 *
 * These four lists used to be environment variables, which meant that changing
 * who could operate the platform from Discord required a redeploy — and that
 * the answer to "who can do this?" lived somewhere the dashboard could not
 * show. They are settings now, and this is the surface every other one is
 * built on: the dashboard page, the CLI, and the bot's own `/access` command
 * all come through here.
 *
 * ## Why this is not owner-gated, when `permissions.ts` is
 *
 * Editing a *role baseline* widens what a dashboard account may do, so it is
 * OWNER-only and no API token can ever reach it — a scoped token is pinned to
 * `ADMIN` in `auth.ts` by construction.
 *
 * These lists are a different kind of thing. They delegate a subset of the
 * bot's *own* authority: a Discord admin can never cause the bot to exceed the
 * scopes on `BOT_API_TOKEN`, because every command it runs is still that token
 * making the call. Adding a Discord admin is lateral, not an escalation, so it
 * is gated on `users:admin` alone. That is also what makes the bot able to
 * administer itself, which is the point — an operator locked out of the
 * dashboard should still be able to fix the allowlist from the channel they
 * are standing in.
 *
 * The consequence is stated plainly rather than hidden: a `users:admin` token
 * can grant Discord users everything that token itself holds. Scope
 * `BOT_API_TOKEN` accordingly.
 */

/** Accepts bare ids or `{id, label}`; the store normalises both. */
const EntryInput = z.union([
  z.string().max(64),
  z.object({ id: z.string().max(64), label: z.string().max(200).optional() }),
]);

const ListInput = z.array(EntryInput).max(500);

const PutBody = z.object({
  guilds: ListInput.optional(),
  channels: ListInput.optional(),
  adminUsers: ListInput.optional(),
  adminRoles: ListInput.optional(),
  mode: z.enum(AUTHZ_MODES).optional(),
});

/**
 * The shape every surface renders.
 *
 * `effective` is the part that matters operationally: it answers "what is the
 * bot actually enforcing right now", which is not the same as what is stored
 * whenever a deployment is still running on its environment fallback.
 */
export interface BotAuthzView {
  entries: AuthzEntries;
  /** True once anything has been stored; false means the bot uses `.env`. */
  configured: boolean;
  /** Which model decides who may run a state-changing command. */
  mode: AuthzMode;
  /**
   * Plain id lists, which is what the bot consumes.
   *
   * In `dashboard` mode `adminUserIds` is *derived* from the operator accounts
   * rather than read from the stored list, so the bot needs no notion of the
   * mode to gate on: it consumes this either way and the answer is already
   * right.
   */
  effective: ReturnType<typeof entriesToIdLists>;
  /** The misconfigurations worth shouting about, in words. */
  warnings: string[];
}

/**
 * Name the two states that silently break the bot, and the one that quietly
 * widens it. An operator reading the page should not have to infer these from
 * four empty lists.
 *
 * These describe the *stored* lists, so they are only true once the stored
 * lists are the ones in force. Before that the bot is running on its
 * environment, which this process cannot read — the bot has it, not the API —
 * and warning that "no channels are allowed" would be stating a falsehood
 * about a deployment whose `.env` is perfectly well configured.
 */
export function warningsFor(
  entries: AuthzEntries,
  configured = true,
  mode: AuthzMode = "allowlist",
  linkedCount = 0,
): string[] {
  if (!configured) {
    return [
      "Nothing is stored yet, so the bot is still using the DISCORD_* variables it was deployed with. " +
        "This page cannot read those — run `/access show` in Discord to see what is actually in force. " +
        "Saving any list below takes over from the environment completely.",
    ];
  }
  const out: string[] = [];
  if (mode === "dashboard" && linkedCount === 0) {
    // The derived list is empty, so nobody can run anything that changes state
    // — and unlike an empty stored list, there is nothing on this page to fix.
    out.push(
      "No operator account has linked a Discord login, so nobody can run a state-changing command. " +
        "Each person signs in to this dashboard and links Discord from their account page.",
    );
  }
  if (entries.channels.length === 0) {
    out.push(
      "No allowed channels: every state-changing command is refused, and read-only commands work in any channel the bot can see.",
    );
  }
  if (mode === "allowlist" && entries.adminUsers.length === 0 && entries.adminRoles.length === 0) {
    out.push("No admin users or roles: every state-changing command is refused.");
  }
  if (entries.guilds.length === 0) {
    out.push(
      "No guilds pinned: the bot answers in every server it has been invited to. Pin at least one unless that is deliberate.",
    );
  }
  return out;
}

export function viewOf(
  entries: AuthzEntries,
  configured: boolean,
  mode: AuthzMode = "allowlist",
  linkedDiscordIds: string[] = [],
): BotAuthzView {
  const effective = entriesToIdLists(entries);
  if (mode === "dashboard") effective.adminUserIds = linkedDiscordIds;
  return {
    entries,
    configured,
    mode,
    effective,
    warnings: warningsFor(entries, configured, mode, linkedDiscordIds.length),
  };
}

export function registerBotAuthzRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.register(async (scope) => {
    scope.addHook(
      "preHandler",
      adminAuthHook({
        adminToken: ctx.config.adminToken,
        session: sessionAuthenticator(ctx),
        apiTokens: ctx.apiTokens,
        impersonation: impersonationResolver(ctx),
      }),
    );
    scope.addHook("preHandler", async (req, reply) => {
      if (!ctx.adminLimiter.allow(req.ip)) {
        await reply.code(429).send({ error: "rate limited" });
      }
    });
    scope.addHook("preHandler", requireScope("users:admin"));

    const actor = (req: FastifyRequest) =>
      req.principal?.name ??
      `admin:${(req.headers["x-actor"] as string | undefined)?.slice(0, 64) ?? req.adminActor ?? "unknown"}`;

    const load = async (): Promise<BotAuthzView> => {
      const mode = await ctx.botAuthz.getMode();
      return viewOf(
        await ctx.botAuthz.get(),
        await ctx.botAuthz.isConfigured(),
        mode,
        mode === "dashboard" ? await ctx.botAuthz.linkedDiscordIds() : [],
      );
    };

    /**
     * What the bot enforces, and what an editor edits.
     *
     * Deliberately readable by any `users:admin` principal including the bot's
     * own token: the bot's `/access show` is how an operator diagnoses "why did
     * it refuse me" without dashboard access, and the answer names only
     * snowflakes the asker can already see in their own client.
     */
    scope.get("/api/v1/admin/discord/authz", async () => load());

    /**
     * Replace one or more lists. Omitted lists are left alone, so the dashboard
     * can save a single card without resending the other three.
     */
    scope.put("/api/v1/admin/discord/authz", async (req, reply) => {
      const parsed = PutBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid body", detail: parsed.error.issues.slice(0, 4) });
      }

      // Reject junk loudly rather than dropping it. A silently-ignored typo in
      // an allowlist leaves the operator believing they granted access that
      // they did not, and they find out when the bot refuses them at 3am.
      const rejected: Record<string, string[]> = {};
      for (const name of AUTHZ_LISTS) {
        const bad = rejectedIds(parsed.data[name]);
        if (bad.length > 0) rejected[name] = bad;
      }
      if (Object.keys(rejected).length > 0) {
        return reply.code(400).send({
          error: "every entry must be a Discord snowflake (digits only)",
          rejected,
          hint: "Turn on Developer Mode in Discord, then right-click the server, channel, user or role and Copy ID. A mention like <@123> or a name is not an id.",
        });
      }

      const before = await ctx.botAuthz.get();
      const beforeMode = await ctx.botAuthz.getMode();
      const patch: Partial<Record<AuthzListName, AuthzEntry[]>> = {};
      for (const name of AUTHZ_LISTS) {
        const input = parsed.data[name];
        if (input) patch[name] = normaliseEntries(input);
      }
      if (parsed.data.mode) await ctx.botAuthz.setMode(parsed.data.mode);
      const after = await ctx.botAuthz.setLists(patch);

      // Record what actually changed, per list, with both sides. "Who let this
      // user in?" is the question an audit log exists to answer, and a single
      // "updated" row with no diff cannot.
      const changes: Record<string, { added: string[]; removed: string[] }> = {};
      for (const name of AUTHZ_LISTS) {
        if (!patch[name]) continue;
        const prev = new Set(before[name].map((e) => e.id));
        const next = new Set(after[name].map((e) => e.id));
        const added = [...next].filter((id) => !prev.has(id));
        const removed = [...prev].filter((id) => !next.has(id));
        if (added.length || removed.length) changes[name] = { added, removed };
      }
      if (Object.keys(changes).length > 0) {
        await ctx.audit.record(actor(req), "discord.authz.update", "discord-bot", changes);
      }

      const mode = await ctx.botAuthz.getMode();
      if (parsed.data.mode && parsed.data.mode !== beforeMode) {
        await ctx.audit.record(actor(req), "discord.authz.mode", "discord-bot", {
          from: beforeMode,
          to: parsed.data.mode,
        });
      }
      return viewOf(after, true, mode, mode === "dashboard" ? await ctx.botAuthz.linkedDiscordIds() : []);
    });

    /**
     * Drop the stored lists and fall back to the environment.
     *
     * The way out of a lockout that does not need psql: whoever still holds the
     * root token can reset to the `.env` the bot was deployed with.
     */
    scope.delete("/api/v1/admin/discord/authz", async (req) => {
      await ctx.botAuthz.clear();
      await ctx.audit.record(actor(req), "discord.authz.reset", "discord-bot");
      return viewOf(await ctx.botAuthz.get(), false, await ctx.botAuthz.getMode());
    });
  });
}
