import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Manifest, hostAllowed } from "../../src/contracts/manifest.js";
import { ResultEnvelope } from "../../src/contracts/envelope.js";

describe("Manifest", () => {
  it("validates the real mangaplus manifest unchanged", () => {
    const candidates = [
      "/Users/Ardax/Documents/GitHub/publoader-extensions/src/mangaplus/manifest.json",
    ];
    for (const path of candidates) {
      let raw: string;
      try {
        raw = readFileSync(path, "utf8");
      } catch {
        continue; // repo not present in CI
      }
      const parsed = Manifest.safeParse(JSON.parse(raw));
      expect(parsed.success, JSON.stringify(parsed)).toBe(true);
      if (parsed.success) {
        expect(parsed.data.name).toBe("mangaplus");
        expect(parsed.data.auto_create_titles).toBe(false);
        expect(parsed.data.min_trust).toBe("COMMUNITY");
      }
    }
  });

  it("rejects invalid names and entrypoints", () => {
    expect(
      Manifest.safeParse({
        name: "Bad Name!",
        version: "1",
        entrypoint: "x.py",
        mangadex_group_id: "4f1de6a2-f0c5-4ac5-bce5-02c7dbb67deb",
        languages: ["en"],
        allowed_hosts: ["a.com"],
      }).success,
    ).toBe(false);
    expect(
      Manifest.safeParse({
        name: "ok",
        version: "1",
        entrypoint: "../escape.sh",
        mangadex_group_id: "4f1de6a2-f0c5-4ac5-bce5-02c7dbb67deb",
        languages: ["en"],
        allowed_hosts: ["a.com"],
      }).success,
    ).toBe(false);
  });
});

describe("hostAllowed", () => {
  const hosts = ["mangaplus.shueisha.co.jp", "tokyo-cdn.com"];
  it("allows exact and subdomain matches only", () => {
    expect(hostAllowed("https://mangaplus.shueisha.co.jp/titles/1", hosts)).toBe(true);
    expect(hostAllowed("https://jumpg-webapi.tokyo-cdn.com/api", hosts)).toBe(true);
    expect(hostAllowed("https://eviltokyo-cdn.com/x", hosts)).toBe(false);
    expect(hostAllowed("https://tokyo-cdn.com.evil.io/x", hosts)).toBe(false);
    expect(hostAllowed("not a url", hosts)).toBe(false);
  });
});

describe("ResultEnvelope", () => {
  const base = {
    envelopeVersion: 1,
    jobId: "00000000-0000-4000-8000-000000000001",
    leaseId: "00000000-0000-4000-8000-000000000002",
    segmentKey: null,
    extension: "mangaplus",
    bundleSha256: "a".repeat(64),
    idempotencyKey: "res:x:1",
    status: "ok",
    error: null,
    updatedChapters: [],
    allChapters: null,
    untrackedManga: [],
    trackedMangadexIds: [],
    mangadexGroupId: null,
    overrideOptions: {},
    extensionLanguages: [],
    stats: {},
  };

  it("accepts a minimal valid envelope", () => {
    expect(ResultEnvelope.safeParse(base).success).toBe(true);
  });

  it("rejects unknown fields (strict) and bad hashes", () => {
    expect(ResultEnvelope.safeParse({ ...base, injected: true }).success).toBe(false);
    expect(ResultEnvelope.safeParse({ ...base, bundleSha256: "xyz" }).success).toBe(false);
  });

  it("rejects chapters with non-uuid MangaDex ids", () => {
    const bad = {
      ...base,
      updatedChapters: [{ chapterId: "1", mdMangaId: "not-a-uuid" }],
    };
    expect(ResultEnvelope.safeParse(bad).success).toBe(false);
  });
});
