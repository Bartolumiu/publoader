import { describe, expect, it } from "vitest";
import { buildErrorEmbed, buildReplyEmbed, inferTone } from "../../src/bot/bot.js";
import { scopeChecker } from "../../src/bot/commands.js";

/**
 * Presentation lives in one place, so this is where it is checked.
 *
 * The rules that matter are the ones Discord enforces silently: an embed over
 * its limits is not truncated, it is *rejected*, and the reply is lost rather
 * than shortened. Everything here is a way of asking whether a reply can still
 * be sent.
 */
describe("inferTone", () => {
  it("reads the marker handlers already use, and removes it", () => {
    // Forty-seven handlers wrote these long before embeds existed; inferring
    // is what let all of them gain a colour without being edited.
    expect(inferTone(":x: it broke")).toEqual({ tone: "error", text: "it broke" });
    expect(inferTone(":warning: careful")).toEqual({ tone: "warn", text: "careful" });
    expect(inferTone(":lock: not allowed")).toEqual({ tone: "denied", text: "not allowed" });
    expect(inferTone(":white_check_mark: done")).toEqual({ tone: "ok", text: "done" });
  });

  it("leaves unmarked text alone", () => {
    expect(inferTone("just a listing")).toEqual({ tone: "info", text: "just a listing" });
  });

  it("only strips a marker at the start, not one mid-sentence", () => {
    const text = "3 queued, 1 failed :warning: check /errors";
    expect(inferTone(text)).toEqual({ tone: "info", text });
  });
});

describe("buildReplyEmbed", () => {
  it("titles an untitled reply with the command that produced it", () => {
    const embed = buildReplyEmbed("status", { text: "fine" }).toJSON();
    expect(embed.title).toContain("/status");
    expect(embed.description).toBe("fine");
  });

  it("lets a handler's explicit tone beat the inferred one", () => {
    const embed = buildReplyEmbed("run", { text: ":warning: started anyway", tone: "ok" }).toJSON();
    // Explicit tone means the text is left exactly as written, marker and all.
    expect(embed.description).toContain(":warning:");
  });

  it("keeps a description within Discord's limit, which rejects rather than truncates", () => {
    const embed = buildReplyEmbed("audit", { text: "x".repeat(9000) }).toJSON();
    expect(embed.description!.length).toBeLessThanOrEqual(4096);
  });

  it("keeps every field within its own limit", () => {
    const embed = buildReplyEmbed("status", {
      text: "",
      fields: [{ name: "y".repeat(500), value: "z".repeat(5000) }],
    }).toJSON();
    expect(embed.fields![0]!.name.length).toBeLessThanOrEqual(256);
    expect(embed.fields![0]!.value.length).toBeLessThanOrEqual(1024);
  });

  it("drops fields past Discord's limit of 25 rather than losing the reply", () => {
    const fields = Array.from({ length: 40 }, (_, i) => ({ name: `f${i}`, value: "v" }));
    const embed = buildReplyEmbed("queue", { text: "", fields }).toJSON();
    expect(embed.fields).toHaveLength(25);
  });

  it("renders an empty field value rather than emitting an invalid embed", () => {
    // Discord rejects an empty field value outright.
    const embed = buildReplyEmbed("status", { text: "", fields: [{ name: "Fleet", value: "" }] }).toJSON();
    expect(embed.fields![0]!.value.length).toBeGreaterThan(0);
  });

  it("omits the description entirely when there is no text", () => {
    const embed = buildReplyEmbed("status", { text: "   ", fields: [{ name: "a", value: "b" }] }).toJSON();
    expect(embed.description).toBeUndefined();
  });

  it("carries a footer when one is given", () => {
    const embed = buildReplyEmbed("status", { text: "ok", footer: "hidden by permissions" }).toJSON();
    expect(embed.footer!.text).toContain("hidden");
  });
});

describe("buildErrorEmbed", () => {
  it("names the command that failed and reads as an error", () => {
    const embed = buildErrorEmbed("run", "403: missing runs:write").toJSON();
    expect(embed.title).toContain("/run failed");
    expect(embed.description).toContain("runs:write");
  });
});

describe("scopeChecker", () => {
  it("answers true for everything when scopes could not be resolved", () => {
    // Rendering must fail *open*: this decides how much of a reply to show,
    // never whether a call is allowed. Blanking working commands because
    // introspection hiccuped would be the worse failure.
    const can = scopeChecker(undefined);
    expect(can("workers:read")).toBe(true);
    expect(scopeChecker([])("workers:read")).toBe(true);
  });

  it("honours a real scope set, including write implying read", () => {
    const can = scopeChecker(["runs:write", "stats:read"]);
    expect(can("runs:write")).toBe(true);
    expect(can("runs:read")).toBe(true);
    expect(can("workers:read")).toBe(false);
  });

  it("treats the wildcard as everything", () => {
    expect(scopeChecker(["*"])("workers:read")).toBe(true);
  });
});
