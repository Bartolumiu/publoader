import { describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import { AuthzSource } from "../../src/bot/authzSource.js";
import type { AdminApiClient, BotAuthzView } from "../../src/bot/apiClient.js";
import { entriesToIdLists, normaliseEntries, rejectedIds } from "../../src/core/store/botAuthz.js";
import type { AuthzEntries } from "../../src/core/store/botAuthz.js";
import { viewOf, warningsFor } from "../../src/core/api/routes/botAuthz.js";
import { snowflakeFrom } from "../../src/bot/commands.js";

const GUILD = "900000000000000001";
const CHANNEL = "800000000000000001";
const ADMIN_USER = "700000000000000001";
const STORED_USER = "700000000000000009";

const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

function entries(over: Partial<AuthzEntries> = {}): AuthzEntries {
  return { guilds: [], channels: [], adminUsers: [], adminRoles: [], ...over };
}

/** An API client that only answers `botAuthz`, which is all the source calls. */
function fakeApi(answer: () => Promise<BotAuthzView>): AdminApiClient {
  return { botAuthz: answer } as unknown as AdminApiClient;
}

const ENV = {
  DISCORD_GUILD_ID: GUILD,
  DISCORD_ALLOWED_CHANNELS: CHANNEL,
  DISCORD_ADMIN_USERS: ADMIN_USER,
};

describe("AuthzSource: precedence", () => {
  it("gates on the environment before the first refresh completes", () => {
    // The bot can receive an interaction the millisecond it connects, well
    // before any HTTP round trip has finished. Starting from an empty config
    // would fail every command; starting from a permissive one would be worse.
    const source = new AuthzSource({ api: fakeApi(() => new Promise(() => {})), env: ENV, log: silentLog });
    expect([...source.config.adminUserIds]).toEqual([ADMIN_USER]);
    expect(source.origin).toBe("env");
    expect(source.loaded).toBe(false);
  });

  it("adopts the stored lists once they exist, replacing the environment wholesale", async () => {
    const stored = entries({ adminUsers: [{ id: STORED_USER, label: "on call" }] });
    const source = new AuthzSource({
      api: fakeApi(async () => viewOf(stored, true)),
      env: ENV,
      log: silentLog,
    });
    await source.refresh();
    // The env admin is gone, not merged: an allowlist assembled from two
    // sources is one nobody can reason about.
    expect([...source.config.adminUserIds]).toEqual([STORED_USER]);
    expect(source.origin).toBe("stored");
  });

  it("keeps using the environment while nothing has been stored", async () => {
    const source = new AuthzSource({
      api: fakeApi(async () => viewOf(entries(), false)),
      env: ENV,
      log: silentLog,
    });
    await source.refresh();
    expect([...source.config.adminUserIds]).toEqual([ADMIN_USER]);
    expect(source.origin).toBe("env");
    expect(source.loaded).toBe(true);
  });
});

describe("AuthzSource: failure is never a widening", () => {
  it("keeps the last known good config when the API goes down", async () => {
    const stored = entries({ adminUsers: [{ id: STORED_USER, label: "" }] });
    let fail = false;
    const source = new AuthzSource({
      api: fakeApi(async () => {
        if (fail) throw new Error("503");
        return viewOf(stored, true);
      }),
      env: ENV,
      log: silentLog,
    });

    await source.refresh();
    fail = true;
    const result = await source.refresh();

    // Falling back to `.env` here would silently re-admit the environment's
    // admin, who may be exactly the person just removed.
    expect(result.changed).toBe(false);
    expect([...source.config.adminUserIds]).toEqual([STORED_USER]);
    expect(source.config.adminUserIds.has(ADMIN_USER)).toBe(false);
  });

  it("stays on the environment when the very first read fails", async () => {
    const source = new AuthzSource({
      api: fakeApi(async () => {
        throw new Error("connection refused");
      }),
      env: ENV,
      log: silentLog,
    });
    await source.refresh();
    expect([...source.config.adminUserIds]).toEqual([ADMIN_USER]);
    expect(source.loaded).toBe(false);
  });

  it("does not empty the lists when the API answers with a failure", async () => {
    const source = new AuthzSource({
      api: fakeApi(async () => {
        throw new Error("500");
      }),
      env: ENV,
      log: silentLog,
    });
    await source.refresh();
    // An outage must not lock every operator out of a working bot.
    expect(source.config.allowedChannelIds.has(CHANNEL)).toBe(true);
  });
});

describe("AuthzSource: change detection", () => {
  it("reports a guild change so the caller can re-register slash commands", async () => {
    let stored = entries({ guilds: [{ id: GUILD, label: "" }] });
    const source = new AuthzSource({
      api: fakeApi(async () => viewOf(stored, true)),
      env: {},
      log: silentLog,
    });
    await source.refresh();

    stored = entries({ guilds: [{ id: GUILD, label: "" }, { id: "900000000000000002", label: "" }] });
    const result = await source.refresh();
    expect(result.guildsChanged).toBe(true);
    expect(result.changed).toBe(true);
  });

  it("reports no change when nothing moved, so the bot does not churn", async () => {
    const stored = entries({ channels: [{ id: CHANNEL, label: "#ops" }] });
    const source = new AuthzSource({
      api: fakeApi(async () => viewOf(stored, true)),
      env: {},
      log: silentLog,
    });
    await source.refresh();
    const result = await source.refresh();
    expect(result.changed).toBe(false);
    expect(result.guildsChanged).toBe(false);
  });

  it("notices a non-guild change without claiming the guilds moved", async () => {
    let stored = entries({ guilds: [{ id: GUILD, label: "" }] });
    const source = new AuthzSource({
      api: fakeApi(async () => viewOf(stored, true)),
      env: {},
      log: silentLog,
    });
    await source.refresh();

    stored = entries({ guilds: [{ id: GUILD, label: "" }], adminUsers: [{ id: ADMIN_USER, label: "" }] });
    const result = await source.refresh();
    expect(result.changed).toBe(true);
    expect(result.guildsChanged).toBe(false);
  });
});

describe("AuthzSource: polling", () => {
  it("stops cleanly and does not fire again", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => viewOf(entries(), false));
    const source = new AuthzSource({ api: fakeApi(fetcher), env: {}, log: silentLog, refreshMs: 1000 });
    source.start();
    await vi.advanceTimersByTimeAsync(2500);
    const calls = fetcher.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    source.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetcher.mock.calls.length).toBe(calls);
    vi.useRealTimers();
  });
});

describe("store: normaliseEntries", () => {
  it("accepts bare ids and labelled objects alike", () => {
    expect(normaliseEntries(["111", { id: "222", label: "#ops" }])).toEqual([
      { id: "111", label: "" },
      { id: "222", label: "#ops" },
    ]);
  });

  it("drops anything that is not a snowflake", () => {
    expect(normaliseEntries(["<@111>", "ardax", "", null, { id: "not-a-number" }, "333"])).toEqual([
      { id: "333", label: "" },
    ]);
  });

  it("deduplicates, keeping the first label seen", () => {
    expect(normaliseEntries([{ id: "111", label: "first" }, { id: "111", label: "second" }])).toEqual([
      { id: "111", label: "first" },
    ]);
  });

  it("treats a non-array as an empty list rather than throwing", () => {
    expect(normaliseEntries(null)).toEqual([]);
    expect(normaliseEntries("111")).toEqual([]);
  });

  it("truncates a label instead of storing an essay", () => {
    const [entry] = normaliseEntries([{ id: "111", label: "x".repeat(500) }]);
    expect(entry?.label.length).toBe(80);
  });
});

describe("store: rejectedIds", () => {
  it("names what was thrown away, so a typo is reported rather than swallowed", () => {
    // A silently-dropped id leaves an operator believing they granted access
    // they did not, and they find out when the bot refuses them.
    expect(rejectedIds(["111", "<@222>", "ardax"])).toEqual(["<@222>", "ardax"]);
  });

  it("says nothing when every entry is valid", () => {
    expect(rejectedIds(["111", { id: "222" }])).toEqual([]);
  });
});

describe("store: entriesToIdLists", () => {
  it("reduces to the bare ids the bot matches on, dropping labels", () => {
    const lists = entriesToIdLists(
      entries({
        guilds: [{ id: GUILD, label: "staff server" }],
        channels: [{ id: CHANNEL, label: "#ops" }],
      }),
    );
    expect(lists).toEqual({
      guildIds: [GUILD],
      allowedChannelIds: [CHANNEL],
      adminUserIds: [],
      adminRoleIds: [],
    });
  });
});

describe("route: warningsFor", () => {
  it("names the two states that make every write fail", () => {
    const warnings = warningsFor(entries());
    expect(warnings.join(" ")).toContain("No allowed channels");
    expect(warnings.join(" ")).toContain("No admin users or roles");
  });

  it("warns about an unpinned guild, which quietly widens the bot", () => {
    expect(warningsFor(entries()).join(" ")).toContain("No guilds pinned");
  });

  it("refuses to judge lists that are not in force yet", () => {
    // Before anything is stored the bot runs on its `.env`, which this process
    // cannot read; "no channels allowed" would be a claim about a file it has
    // never seen.
    const warnings = warningsFor(entries(), false);
    expect(warnings.join(" ")).toContain("still using the DISCORD_* variables");
    expect(warnings.join(" ")).not.toContain("No allowed channels");
  });

  it("says nothing when the deployment is locked down", () => {
    const locked = entries({
      guilds: [{ id: GUILD, label: "" }],
      channels: [{ id: CHANNEL, label: "" }],
      adminUsers: [{ id: ADMIN_USER, label: "" }],
    });
    expect(warningsFor(locked)).toEqual([]);
  });

  it("accepts admin roles alone as an admin allowlist", () => {
    const byRole = entries({
      guilds: [{ id: GUILD, label: "" }],
      channels: [{ id: CHANNEL, label: "" }],
      adminRoles: [{ id: "600000000000000001", label: "@staff" }],
    });
    expect(warningsFor(byRole)).toEqual([]);
  });
});

describe("snowflakeFrom", () => {
  it("accepts the mention syntax Discord inserts for you", () => {
    expect(snowflakeFrom("<#800000000000000001>")).toBe(CHANNEL);
    expect(snowflakeFrom("<@700000000000000001>")).toBe(ADMIN_USER);
    expect(snowflakeFrom("<@!700000000000000001>")).toBe(ADMIN_USER);
    expect(snowflakeFrom("<@&600000000000000001>")).toBe("600000000000000001");
  });

  it("accepts a bare id, with or without stray whitespace", () => {
    expect(snowflakeFrom(` ${GUILD} `)).toBe(GUILD);
  });

  it("refuses a name, a partial mention, or nothing at all", () => {
    expect(snowflakeFrom("ardax")).toBeNull();
    expect(snowflakeFrom("<@ardax>")).toBeNull();
    expect(snowflakeFrom("")).toBeNull();
    expect(snowflakeFrom(null)).toBeNull();
    // Short enough to be a typo rather than a snowflake.
    expect(snowflakeFrom("123")).toBeNull();
  });
});
