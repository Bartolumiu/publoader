/** Seed the throwaway verification database with enough to exercise every view. */
import { PrismaClient } from "@prisma/client";

const DEFAULT_DATABASE_URL =
  "postgresql://publoader:dev@localhost:55432/publoader_browser?schema=public";

const prisma = new PrismaClient({
  // Same DATABASE_URL the API under test was started with. Hardcoding a
  // database name here once tied this harness to a scratch database that was
  // later dropped, which is a confusing way to discover the seed did nothing.
  datasources: { db: { url: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL } },
});

const manifest = {
  name: "mangaplus",
  version: "2.1.0",
  publoader_api: "^2.0.0",
  runtime: "node",
  entrypoint: "index.js",
  languages: ["en", "es-la"],
  allowed_hosts: ["jumpg-webapi.tokyo-cdn.com", "mangaplus.shueisha.co.jp"],
  mangadex_group_id: "4f1de6a2-f0c5-4ac5-bce5-02c7dbb67deb",
  class_name: "Extension",
  min_trust: "COMMUNITY",
  schedule: { hour: 3, minute: 30 },
};

await prisma.bundle.upsert({
  where: { extension_version: { extension: "mangaplus", version: "2.1.0" } },
  update: { manifest },
  create: {
    extension: "mangaplus",
    version: "2.1.0",
    sha256: "a".repeat(64),
    manifest,
    sourceCommit: "b".repeat(40),
    archive: Buffer.from("not-a-real-zip"),
  },
});
await prisma.bundle.upsert({
  where: { extension_version: { extension: "mangaplus", version: "2.0.4" } },
  update: {},
  create: {
    extension: "mangaplus",
    version: "2.0.4",
    sha256: "c".repeat(64),
    manifest: { ...manifest, version: "2.0.4" },
    archive: Buffer.from("older"),
    publishedAt: new Date(Date.now() - 86_400_000 * 9),
  },
});

for (let i = 0; i < 4; i++) {
  await prisma.trackedManga.upsert({
    where: { extension_namespace_mangaId: { extension: "mangaplus", namespace: "", mangaId: `1000${i}` } },
    update: {},
    create: {
      extension: "mangaplus",
      mangaId: `1000${i}`,
      mdMangaId: `0000000${i}-0000-4000-8000-00000000000${i}`,
      source: "auto",
    },
  });
}

const untracked = [
  { name: "Kimi ni Todoke: Second Season", lang: "en", state: "NEW", md: null },
  { name: "SPY x FAMILY  (raw scrape)", lang: "en", state: "NEW", md: null },
  {
    name: "Sakamoto Days",
    lang: "en",
    state: "TRACKED",
    md: "11111111-1111-4111-8111-111111111111",
  },
  { name: "Broken title", lang: "en", state: "FAILED", md: null, error: "mangadex rejected: title too long" },
];
for (const [i, u] of untracked.entries()) {
  await prisma.untrackedManga.upsert({
    where: { extension_mangaId_mangaLanguage: { extension: "mangaplus", mangaId: `9${i}`, mangaLanguage: u.lang } },
    update: {},
    create: {
      extension: "mangaplus",
      mangaId: `9${i}`,
      mangaName: u.name,
      mangaLanguage: u.lang,
      mangaUrl: `https://mangaplus.shueisha.co.jp/titles/9${i}`,
      state: u.state,
      mdMangaId: u.md,
      lastError: u.error ?? null,
      attempts: u.state === "FAILED" ? 3 : 0,
    },
  });
}

await prisma.worker.upsert({
  where: { tokenHash: "seed-worker-a" },
  update: {},
  create: {
    name: "publoader-worker-a",
    tokenHash: "seed-worker-a",
    status: "ACTIVE",
    trust: "TRUSTED",
    extensions: ["mangaplus"],
    lastHeartbeatAt: new Date(Date.now() - 12_000),
    agentVersion: "2.0.2",
  },
});

// Enough audit history that a permalink to the oldest row is genuinely off the
// first page at limit=25 — which is the case the old client-side filter could
// never resolve.
const existing = await prisma.auditEvent.count();
if (existing < 60) {
  for (let i = 0; i < 60; i++) {
    await prisma.auditEvent.create({
      data: {
        actor: i % 3 === 0 ? "token:discord-bot" : "iam@ardax.dev",
        action: ["run.trigger", "tracked_manga.set", "removal_mode.set", "extension.disable"][i % 4],
        subject: `mangaplus:1000${i % 4}`,
        detail: { seeded: true, index: i, note: `synthetic audit row ${i}` },
        createdAt: new Date(Date.now() - (i + 1) * 3_600_000),
      },
    });
  }
}

console.log(
  "seeded:",
  JSON.stringify({
    bundles: await prisma.bundle.count(),
    tracked: await prisma.trackedManga.count(),
    untracked: await prisma.untrackedManga.count(),
    workers: await prisma.worker.count(),
    audit: await prisma.auditEvent.count(),
  }),
);
await prisma.$disconnect();
