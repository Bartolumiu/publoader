import { describe, expect, it } from "vitest";
import { describeRegistrationFailure } from "../../src/bot/commands.js";

/**
 * The log line an operator reads at 1am when the bot has no commands.
 *
 * Written because the previous version asserted one cause ("the invite probably
 * omitted `applications.commands`") for every failure, and the real one was a
 * 400 from a malformed command definition — so the log actively pointed at
 * Discord's settings when the bug was in this repo.
 */
describe("describeRegistrationFailure", () => {
  it("says a 400 is our command definitions, and that it breaks every guild", () => {
    const message = describeRegistrationFailure({ status: 400 });
    expect(message).toContain("400");
    expect(message).toContain("NO guild");
    // Points at the check that would have caught it before deploy.
    expect(message).toContain("botCommandShape");
    expect(message).not.toContain("applications.commands");
  });

  it("says a 403 is the missing scope, which is a Discord-side fix", () => {
    const message = describeRegistrationFailure({ status: 403 });
    expect(message).toContain("applications.commands");
    expect(message).toContain("re-authorize");
  });

  it("says a 404 means the bot is not in the guild", () => {
    expect(describeRegistrationFailure({ status: 404 })).toContain("not a member");
  });

  it("stays neutral rather than guessing on anything else", () => {
    for (const err of [{ status: 500 }, {}, null, undefined, new Error("boom")]) {
      const message = describeRegistrationFailure(err);
      expect(message).toContain("refused the registration");
      expect(message).not.toContain("applications.commands");
    }
  });
});
