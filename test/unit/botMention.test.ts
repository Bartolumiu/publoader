import { describe, expect, it } from "vitest";
import { mentionReport, parentIdOfChannel, type MentionFacts } from "../../src/bot/bot.js";

/** A fully working deployment, seen from inside an allowed channel. */
function facts(over: Partial<MentionFacts> = {}): MentionFacts {
  return {
    anyGuildPinned: true,
    guildPinned: true,
    anyChannelConfigured: true,
    channelAllowed: true,
    adminsConfigured: true,
    isAdmin: true,
    ...over,
  };
}

describe("mentionReport", () => {
  it("confirms a healthy setup without raising alarms", () => {
    const report = mentionReport(facts());
    expect(report).toContain("online");
    expect(report).toContain("pinned");
    expect(report).toContain("allowed");
    expect(report).not.toContain(":x:");
  });

  it("names an unpinned server as the reason commands are missing", () => {
    // The failure this whole handler exists for: no slash commands, and no way
    // from inside Discord to find out why.
    const report = mentionReport(facts({ guildPinned: false }));
    expect(report).toContain("not** on the bot's guild list");
    expect(report).toContain("Discord bot access");
  });

  it("explains global registration when no guild is pinned at all", () => {
    const report = mentionReport(facts({ anyGuildPinned: false, guildPinned: false }));
    expect(report).toContain("no guild is pinned");
    expect(report).toContain("up to an hour");
    expect(report).not.toContain("not** on the bot's guild list");
  });

  it("names a disallowed channel, and points at the thread rule", () => {
    const report = mentionReport(facts({ channelAllowed: false }));
    expect(report).toContain("not on the allowed-channel list");
    expect(report).toContain("parent channel");
  });

  it("says plainly when no channels are configured, which fails writes everywhere", () => {
    const report = mentionReport(facts({ anyChannelConfigured: false, channelAllowed: false }));
    expect(report).toContain("no allowed channels are configured");
    expect(report).toContain("state-changing command is refused");
  });

  it("distinguishes 'you are not an admin' from 'nobody is'", () => {
    expect(mentionReport(facts({ isAdmin: false }))).toContain("not an admin");
    const none = mentionReport(facts({ adminsConfigured: false, isAdmin: false }));
    expect(none).toContain("no admins are configured at all");
    expect(none).not.toContain("read-only commands only");
  });

  it("never leaks a snowflake, so it is safe to answer to anyone", () => {
    // The reply goes to whoever mentioned the bot, in a channel the bot cannot
    // choose. It may describe the asker's own situation; it may not hand out
    // the shape of the deployment.
    for (const over of [{}, { guildPinned: false }, { channelAllowed: false }, { isAdmin: false }]) {
      expect(mentionReport(facts(over))).not.toMatch(/\d{15,}/);
    }
  });

  it("always reports every gate, so one bad line cannot hide another", () => {
    const report = mentionReport(facts({ guildPinned: false, channelAllowed: false, isAdmin: false }));
    expect(report).toContain("**Server**");
    expect(report).toContain("**Channel**");
    expect(report).toContain("**You**");
  });
});

describe("parentIdOfChannel", () => {
  it("returns the parent for the three thread types", () => {
    for (const type of [10, 11, 12]) {
      expect(parentIdOfChannel({ type, parentId: "800000000000000001" })).toBe("800000000000000001");
    }
  });

  it("ignores a text channel's parent, which is its category", () => {
    // Honouring it would silently widen a one-channel allowlist to every
    // channel in the category.
    expect(parentIdOfChannel({ type: 0, parentId: "700000000000000001" })).toBeNull();
  });

  it("tolerates anything that is not a channel", () => {
    expect(parentIdOfChannel(null)).toBeNull();
    expect(parentIdOfChannel(undefined)).toBeNull();
    expect(parentIdOfChannel("thread")).toBeNull();
    expect(parentIdOfChannel({ type: 11 })).toBeNull();
    expect(parentIdOfChannel({ type: 11, parentId: null })).toBeNull();
  });
});
