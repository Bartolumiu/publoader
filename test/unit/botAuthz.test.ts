import { describe, expect, it } from "vitest";
import {
  authorize,
  authzFromLists,
  authzToLists,
  cleanIdList,
  describeAuthz,
  hasAdminAllowlist,
  isAdmin,
  isAuthzEmpty,
  loadAuthzConfig,
  parseIdList,
  type AuthzConfig,
  type Invoker,
} from "../../src/bot/authz.js";

const GUILD = "900000000000000001";
const CHANNEL = "800000000000000001";
const OTHER_CHANNEL = "800000000000000002";
const ADMIN_USER = "700000000000000001";
const PLAIN_USER = "700000000000000002";
const ADMIN_ROLE = "600000000000000001";
const OTHER_GUILD = "900000000000000002";
const THREAD = "800000000000000009";

/** A fully locked-down config: guild pinned, one channel, one admin user. */
function config(over: Partial<AuthzConfig> = {}): AuthzConfig {
  return {
    guildIds: new Set([GUILD]),
    adminUserIds: new Set([ADMIN_USER]),
    adminRoleIds: new Set([ADMIN_ROLE]),
    allowedChannelIds: new Set([CHANNEL]),
    ...over,
  };
}

function invoker(over: Partial<Invoker> = {}): Invoker {
  return { userId: PLAIN_USER, roleIds: [], channelId: CHANNEL, guildId: GUILD, ...over };
}

describe("parseIdList", () => {
  it("accepts comma- and space-separated snowflakes in any mix", () => {
    expect([...parseIdList("111, 222  333,444")]).toEqual(["111", "222", "333", "444"]);
  });

  it("treats an unset or blank value as an empty list", () => {
    expect(parseIdList(undefined).size).toBe(0);
    expect(parseIdList("").size).toBe(0);
    expect(parseIdList("   ,  ").size).toBe(0);
  });

  it("drops non-numeric junk rather than letting it into the allowlist", () => {
    // Mention syntax and usernames are what operators actually paste; neither
    // may be silently accepted as an id.
    expect([...parseIdList("<@111> ardax 222 3x4")]).toEqual(["222"]);
  });

  it("deduplicates", () => {
    expect([...parseIdList("111 111,111")]).toEqual(["111"]);
  });
});

describe("loadAuthzConfig", () => {
  it("reads every gate from the environment", () => {
    const loaded = loadAuthzConfig({
      DISCORD_GUILD_ID: GUILD,
      DISCORD_ADMIN_USERS: `${ADMIN_USER},${PLAIN_USER}`,
      DISCORD_ADMIN_ROLES: ADMIN_ROLE,
      DISCORD_ALLOWED_CHANNELS: `${CHANNEL} ${OTHER_CHANNEL}`,
    });
    expect([...loaded.guildIds]).toEqual([GUILD]);
    expect(loaded.adminUserIds.size).toBe(2);
    expect(loaded.adminRoleIds.has(ADMIN_ROLE)).toBe(true);
    expect(loaded.allowedChannelIds.size).toBe(2);
  });

  it("treats a non-numeric guild id as unset instead of matching nothing", () => {
    expect(loadAuthzConfig({ DISCORD_GUILD_ID: "my-guild" }).guildIds.size).toBe(0);
  });

  it("accepts several guilds, so one bot can serve two servers", () => {
    const loaded = loadAuthzConfig({ DISCORD_GUILD_ID: `${GUILD},${OTHER_GUILD}` });
    expect([...loaded.guildIds]).toEqual([GUILD, OTHER_GUILD]);
  });

  it("defaults everything to empty on a bare environment", () => {
    const loaded = loadAuthzConfig({});
    expect(loaded.guildIds.size).toBe(0);
    expect(hasAdminAllowlist(loaded)).toBe(false);
  });
});

describe("isAdmin", () => {
  it("matches on explicit user id", () => {
    expect(isAdmin(config(), invoker({ userId: ADMIN_USER }))).toBe(true);
  });

  it("matches on role membership", () => {
    expect(isAdmin(config(), invoker({ roleIds: ["x", ADMIN_ROLE] }))).toBe(true);
  });

  it("is false for a plain member with unrelated roles", () => {
    expect(isAdmin(config(), invoker({ roleIds: ["599999999999999999"] }))).toBe(false);
  });

  it("is false when nothing is configured; no implicit admin", () => {
    const empty = config({ adminUserIds: new Set(), adminRoleIds: new Set() });
    expect(isAdmin(empty, invoker({ userId: ADMIN_USER }))).toBe(false);
  });
});

describe("authorize: guild gate", () => {
  it("refuses commands from another guild", () => {
    const decision = authorize(config(), invoker({ guildId: "999" }), "read");
    expect(decision).toMatchObject({ allowed: false });
    expect(decision.allowed === false && decision.reason).toContain("different guild");
  });

  it("refuses DMs when a guild is pinned", () => {
    const decision = authorize(config(), invoker({ guildId: null }), "read");
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain("not in DMs");
  });

  it("allows any guild when DISCORD_GUILD_ID is unset", () => {
    const anyGuild = config({ guildIds: new Set() });
    expect(authorize(anyGuild, invoker({ guildId: "12345" }), "read").allowed).toBe(true);
  });

  it("checks the guild before the channel, so the reason names the outer problem", () => {
    const decision = authorize(config(), invoker({ guildId: "999", channelId: OTHER_CHANNEL }), "read");
    expect(decision.allowed === false && decision.reason).toContain("guild");
  });
});

describe("authorize: channel gate", () => {
  it("allows a listed channel", () => {
    expect(authorize(config(), invoker(), "read").allowed).toBe(true);
  });

  it("refuses an unlisted channel even for reads", () => {
    const decision = authorize(config(), invoker({ channelId: OTHER_CHANNEL }), "read");
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain("allowed-channel list");
  });

  it("allows reads anywhere when no channel list is configured", () => {
    const open = config({ allowedChannelIds: new Set() });
    expect(authorize(open, invoker({ channelId: "any" }), "read").allowed).toBe(true);
  });

  it("refuses writes when no channel list is configured; the legacy bot allowed them", () => {
    // The Python bot's _channel_allowed() returned True on an empty list, so an
    // incomplete .env let every channel control the platform. This is the
    // deliberate break.
    const open = config({ allowedChannelIds: new Set() });
    const decision = authorize(open, invoker({ userId: ADMIN_USER, channelId: "any" }), "mutate");
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain("DISCORD_ALLOWED_CHANNELS");
  });
});

describe("authorize: privilege gate", () => {
  it("lets a non-admin read", () => {
    expect(authorize(config(), invoker(), "read").allowed).toBe(true);
  });

  it("refuses a non-admin any mutation", () => {
    const decision = authorize(config(), invoker(), "mutate");
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain("restricted to platform admins");
  });

  it("lets an admin mutate, by id or by role", () => {
    expect(authorize(config(), invoker({ userId: ADMIN_USER }), "mutate").allowed).toBe(true);
    expect(authorize(config(), invoker({ roleIds: [ADMIN_ROLE] }), "mutate").allowed).toBe(true);
  });

  it("gates destructive commands the same way, with a reason that says so", () => {
    const denied = authorize(config(), invoker(), "destructive");
    expect(denied.allowed === false && denied.reason).toContain("destructive");
    expect(authorize(config(), invoker({ userId: ADMIN_USER }), "destructive").allowed).toBe(true);
  });

  it("refuses every mutation when no admin is configured, rather than allowing all of them", () => {
    // The legacy _is_admin() returned True when both lists were empty.
    const noAdmins = config({ adminUserIds: new Set(), adminRoleIds: new Set() });
    const decision = authorize(noAdmins, invoker({ userId: ADMIN_USER }), "mutate");
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain("DISCORD_ADMIN_USERS");
    // Reads still work, so the bot remains useful while being configured.
    expect(authorize(noAdmins, invoker(), "read").allowed).toBe(true);
  });

  it("denies writes on a completely unconfigured bot", () => {
    const bare = loadAuthzConfig({});
    expect(authorize(bare, invoker({ guildId: "1", channelId: "2" }), "mutate").allowed).toBe(false);
    expect(authorize(bare, invoker({ guildId: "1", channelId: "2" }), "read").allowed).toBe(true);
  });
});

describe("describeAuthz", () => {
  it("spells out a locked-down configuration", () => {
    const summary = describeAuthz(config());
    expect(summary).toContain(`guild ${GUILD}`);
    expect(summary).toContain("1 allowed channel(s)");
    expect(summary).toContain("1 admin user(s)");
  });

  it("shouts about the two misconfigurations that matter", () => {
    const summary = describeAuthz(loadAuthzConfig({}));
    expect(summary).toContain("NONE for writes");
    expect(summary).toContain("admins: NONE configured");
  });

  it("counts several guilds rather than printing an unreadable list", () => {
    expect(describeAuthz(config({ guildIds: new Set([GUILD, OTHER_GUILD]) }))).toContain("2 guilds");
  });

  it("says plainly when no guild is pinned", () => {
    expect(describeAuthz(config({ guildIds: new Set() }))).toContain("guild: any");
  });
});

describe("authorize: threads", () => {
  it("allows a thread whose parent channel is on the list", () => {
    // Discord reports the thread's own id as the interaction channel, so
    // without the parent an operator who allowlisted #ops is refused the moment
    // they open a thread inside #ops.
    const inThread = invoker({ channelId: THREAD, parentChannelId: CHANNEL });
    expect(authorize(config(), inThread, "read").allowed).toBe(true);
    expect(authorize(config(), { ...inThread, userId: ADMIN_USER }, "mutate").allowed).toBe(true);
  });

  it("refuses a thread whose parent is not on the list", () => {
    const decision = authorize(config(), invoker({ channelId: THREAD, parentChannelId: OTHER_CHANNEL }), "read");
    expect(decision.allowed).toBe(false);
  });

  it("refuses a thread with no parent, rather than reading absence as a pass", () => {
    expect(authorize(config(), invoker({ channelId: THREAD, parentChannelId: null }), "read").allowed).toBe(false);
    expect(authorize(config(), invoker({ channelId: THREAD }), "read").allowed).toBe(false);
  });

  it("still allows the parent channel itself", () => {
    expect(authorize(config(), invoker({ channelId: CHANNEL, parentChannelId: null }), "read").allowed).toBe(true);
  });
});

describe("authorize: several guilds", () => {
  const two = () => config({ guildIds: new Set([GUILD, OTHER_GUILD]) });

  it("answers in every pinned guild", () => {
    expect(authorize(two(), invoker({ guildId: GUILD }), "read").allowed).toBe(true);
    expect(authorize(two(), invoker({ guildId: OTHER_GUILD }), "read").allowed).toBe(true);
  });

  it("still refuses an unpinned guild, and DMs", () => {
    expect(authorize(two(), invoker({ guildId: "999" }), "read").allowed).toBe(false);
    expect(authorize(two(), invoker({ guildId: null }), "read").allowed).toBe(false);
  });

  it("applies one admin list across both guilds", () => {
    const admin = invoker({ userId: ADMIN_USER, guildId: OTHER_GUILD });
    expect(authorize(two(), admin, "mutate").allowed).toBe(true);
    expect(authorize(two(), invoker({ guildId: OTHER_GUILD }), "mutate").allowed).toBe(false);
  });
});

describe("authzFromLists / authzToLists", () => {
  it("round-trips a config through the wire shape", () => {
    const restored = authzFromLists(authzToLists(config()));
    expect([...restored.guildIds]).toEqual([GUILD]);
    expect([...restored.adminUserIds]).toEqual([ADMIN_USER]);
    expect([...restored.adminRoleIds]).toEqual([ADMIN_ROLE]);
    expect([...restored.allowedChannelIds]).toEqual([CHANNEL]);
  });

  it("applies the same digits-only filter as the environment path", () => {
    // Stored config is edited by humans through a dashboard textarea, so it can
    // carry exactly the junk `.env` did; neither source may widen a gate.
    const built = authzFromLists({ adminUserIds: ["<@111>", "222", "", "not-an-id"] });
    expect([...built.adminUserIds]).toEqual(["222"]);
  });

  it("treats a missing or empty payload as fully empty rather than throwing", () => {
    expect(isAuthzEmpty(authzFromLists(null))).toBe(true);
    expect(isAuthzEmpty(authzFromLists({}))).toBe(true);
    expect(isAuthzEmpty(config())).toBe(false);
  });

  it("drops non-string entries that a hand-rolled API call could send", () => {
    expect([...cleanIdList([123, null, "456", undefined])]).toEqual(["456"]);
  });
});
