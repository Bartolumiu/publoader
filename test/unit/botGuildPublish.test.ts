import { describe, expect, it, vi } from "vitest";
import { publishToGuilds } from "../../src/bot/bot.js";

const GUILD_A = "536329001573023766";
const GUILD_B = "403905762268545024";
const GUILD_C = "900000000000000003";

/** `isMember` true for everything unless told otherwise. */
function io(over: { members?: string[]; failOn?: string[] } = {}) {
  const published: string[] = [];
  return {
    published,
    isMember: (id: string) => (over.members ? over.members.includes(id) : true),
    publish: async (id: string) => {
      if (over.failOn?.includes(id)) throw new Error(`Missing Access: ${id}`);
      published.push(id);
    },
  };
}

describe("publishToGuilds", () => {
  it("publishes to every pinned guild", async () => {
    const fake = io();
    const result = await publishToGuilds([GUILD_A, GUILD_C], fake);
    expect(fake.published).toEqual([GUILD_A, GUILD_C]);
    expect(result.registered).toEqual([GUILD_A, GUILD_C]);
    expect(result.failed).toEqual([]);
  });

  it("keeps going when a guild refuses, so one bad id costs only itself", async () => {
    // The regression this exists for: a shared try/catch meant the first
    // failure aborted the loop, and every guild — including ones that had been
    // working — lost its commands.
    const fake = io({ failOn: [GUILD_B] });
    const result = await publishToGuilds([GUILD_B, GUILD_A, GUILD_C], fake);
    expect(fake.published).toEqual([GUILD_A, GUILD_C]);
    expect(result.registered).toEqual([GUILD_A, GUILD_C]);
    expect(result.failed.map((f) => f.guildId)).toEqual([GUILD_B]);
  });

  it("skips a guild the bot was never invited to, without calling Discord", async () => {
    // Pinning an id on the dashboard before inviting the bot is the natural
    // order to do those two things in, so it must be a named outcome rather
    // than a bare 404 from the API.
    const fake = io({ members: [GUILD_A] });
    const result = await publishToGuilds([GUILD_A, GUILD_B], fake);
    expect(fake.published).toEqual([GUILD_A]);
    expect(result.notMember).toEqual([GUILD_B]);
    expect(result.failed).toEqual([]);
    expect(result.registered).toEqual([GUILD_A]);
  });

  it("separates 'not invited' from 'refused the write'; they need different fixes", async () => {
    const fake = io({ members: [GUILD_A, GUILD_B], failOn: [GUILD_B] });
    const result = await publishToGuilds([GUILD_A, GUILD_B, GUILD_C], fake);
    expect(result.registered).toEqual([GUILD_A]);
    expect(result.failed.map((f) => f.guildId)).toEqual([GUILD_B]);
    expect(result.notMember).toEqual([GUILD_C]);
  });

  it("carries the error so the log can name the cause", async () => {
    const result = await publishToGuilds([GUILD_B], io({ failOn: [GUILD_B] }));
    expect((result.failed[0]?.err as Error).message).toContain("Missing Access");
  });

  it("reports nothing registered when every guild is unreachable", async () => {
    // The caller turns this into one loud line; a bot with no commands anywhere
    // must not look like a successful start.
    const result = await publishToGuilds([GUILD_B, GUILD_C], io({ members: [] }));
    expect(result.registered).toEqual([]);
    expect(result.notMember).toEqual([GUILD_B, GUILD_C]);
  });

  it("does nothing at all when no guild is pinned", async () => {
    const fake = io();
    const publish = vi.spyOn(fake, "publish");
    const result = await publishToGuilds([], fake);
    expect(publish).not.toHaveBeenCalled();
    expect(result).toEqual({ registered: [], notMember: [], failed: [] });
  });
});
