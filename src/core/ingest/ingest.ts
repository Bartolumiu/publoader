import type { PrismaClient } from "@prisma/client";
import type { Logger } from "../../logging.js";
import { Manifest, hostAllowed } from "../../contracts/manifest.js";
import { ResultEnvelope } from "../../contracts/envelope.js";
import { metrics } from "../../metrics.js";
import { JobStore } from "../store/jobs.js";
import { ResultStore, type IngestOutcome } from "../store/results.js";
import { ArtifactStore } from "../store/artifacts.js";
import { AuditLog } from "../store/settings.js";
import { ExtensionConfigStore } from "../store/extensionConfig.js";

/**
 * Result-envelope ingestion: the ONLY path by which worker output enters the
 * system. Order of gates:
 *   1. record (idempotent by envelope idempotency key)
 *   2. lease validity  -> stale/duplicate leases become SUPERSEDED, never data
 *   3. worker-reported error -> job retry/dead-letter path
 *   4. policy validation against the CORE's manifest copy -> QUARANTINED
 *   5. atomic commit marker + job SUCCEEDED (exactly-once per job)
 */
export class IngestService {
  private readonly results: ResultStore;
  private readonly artifacts: ArtifactStore;
  private readonly audit: AuditLog;
  private readonly extensionConfig: ExtensionConfigStore;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly jobs: JobStore,
    private readonly log: Logger,
  ) {
    this.results = new ResultStore(prisma);
    this.artifacts = new ArtifactStore(prisma);
    this.audit = new AuditLog(prisma);
    this.extensionConfig = new ExtensionConfigStore(prisma);
  }

  async ingest(rawEnvelope: unknown, workerId: string): Promise<IngestOutcome | { outcome: "invalid"; reason: string }> {
    const parsed = ResultEnvelope.safeParse(rawEnvelope);
    if (!parsed.success) {
      // Not even well-formed: no job to attribute it to reliably; reject at
      // the transport layer. (Recorded via metrics + log, not the DB.)
      metrics.envelopesQuarantined.inc({ extension: "unknown", reason: "schema" });
      return { outcome: "invalid", reason: parsed.error.message.slice(0, 2000) };
    }
    const envelope = parsed.data;
    const log = this.log.child({ jobId: envelope.jobId, workerId, extension: envelope.extension });
    metrics.envelopesReceived.inc({ extension: envelope.extension });

    const job = await this.prisma.job.findUnique({ where: { id: envelope.jobId } });
    if (!job) return { outcome: "invalid", reason: "unknown job" };

    const { submission, duplicate } = await this.results.record(envelope, workerId, job.attempt);
    if (duplicate && submission.state !== "RECEIVED") {
      // Worker retried after we already judged this envelope — idempotent ack.
      return this.priorOutcome(submission.state, submission.id, submission.rejectReason);
    }

    // Gate 2: only the current lease holder may affect the job.
    const leaseValid =
      job.leaseId === envelope.leaseId &&
      job.leaseWorkerId === workerId &&
      (job.state === "LEASED" || job.state === "RUNNING");
    if (!leaseValid) {
      await this.results.markSuperseded(submission.id, "lease not current (expired, reassigned, or job terminal)");
      metrics.envelopesSuperseded.inc({ extension: envelope.extension });
      log.warn({ leaseId: envelope.leaseId }, "envelope superseded: stale lease");
      return { outcome: "superseded", submissionId: submission.id, reason: "stale lease" };
    }

    // Gate 3: worker-reported failure — route through the retry policy.
    if (envelope.status === "error") {
      const errorClass = envelope.error?.class ?? "TRANSIENT";
      const disposition = await this.jobs.fail(
        job.id,
        envelope.leaseId,
        errorClass,
        envelope.error?.message ?? "worker reported an unspecified error",
      );
      await this.results.markSuperseded(submission.id, `worker-reported ${errorClass} error`);
      metrics.jobsRequeued.inc({ extension: envelope.extension, reason: "worker_error" });
      log.warn({ disposition, errorClass }, "worker reported job failure");
      return { outcome: "job_failed", submissionId: submission.id, disposition };
    }

    // Gate 4: policy validation against the core's manifest for the pinned bundle.
    const policyError = await this.validatePolicy(envelope, job.bundleSha256);
    if (policyError) {
      await this.results.markQuarantined(submission.id, policyError);
      metrics.envelopesQuarantined.inc({ extension: envelope.extension, reason: "policy" });
      await this.audit.record(`worker:${workerId}`, "envelope.quarantine", job.id, { policyError });
      // Policy violations dead-letter the job: rerunning the same bundle will
      // produce the same violation, and an operator should look at it.
      await this.jobs.fail(job.id, envelope.leaseId, "POLICY", policyError);
      log.error({ policyError }, "envelope quarantined");
      return { outcome: "quarantined", submissionId: submission.id, reason: policyError };
    }

    // Gate 5: exactly-once commit.
    const committed = await this.results.commit(submission.id, job.id, envelope.leaseId);
    if (!committed) {
      await this.results.markSuperseded(submission.id, "another submission committed first");
      metrics.envelopesSuperseded.inc({ extension: envelope.extension });
      return { outcome: "superseded", submissionId: submission.id, reason: "lost commit race" };
    }

    // Keep referenced artifacts alive past their upload TTL.
    const artifactIds = [
      ...envelope.updatedChapters.flatMap((c) => c.imageArtifacts),
      ...(envelope.allChapters ?? []).flatMap((c) => c.imageArtifacts),
    ];
    await this.artifacts.pin(artifactIds);

    metrics.envelopesCommitted.inc({ extension: envelope.extension });
    metrics.jobsSucceeded.inc({ extension: envelope.extension });
    if (envelope.stats.durationS !== undefined) {
      metrics.jobDuration.observe({ extension: envelope.extension }, envelope.stats.durationS);
    }
    log.info({ chapters: envelope.updatedChapters.length }, "envelope committed");
    return { outcome: "committed", submissionId: submission.id };
  }

  /**
   * Enforce the manifest and the database as policy on the DATA.
   *
   * The rule this function exists to uphold: **every field the downstream
   * pipeline trusts must be checked here**, because a worker is untrusted and
   * this is the only gate between it and canonical state. That is easy to get
   * subtly wrong — an earlier version validated three fields while the
   * processor went on to consume a dozen, and the gap was exploitable: a
   * worker holding one legitimate lease could name any MangaDex title in
   * `mdMangaId`, send `allChapters: []`, and have the processor conclude that
   * every chapter the group owns on that title had vanished upstream and queue
   * it for deletion. So the checks below are deliberately exhaustive over the
   * envelope, and anything the processor reads that is NOT checked here must
   * instead be re-derived from the database (see processor.ts).
   */
  private async validatePolicy(envelope: ResultEnvelope, bundleSha256: string): Promise<string | null> {
    if (envelope.bundleSha256 !== bundleSha256) {
      return `bundle pin mismatch: job pinned ${bundleSha256}, worker ran ${envelope.bundleSha256}`;
    }
    const bundle = await this.prisma.bundle.findUnique({ where: { sha256: bundleSha256 } });
    if (!bundle) return "pinned bundle not found";
    const manifest = Manifest.safeParse(bundle.manifest);
    if (!manifest.success) return "pinned bundle has invalid manifest";
    const m = manifest.data;

    if (envelope.extension !== m.name) {
      return `extension name mismatch: ${envelope.extension} != ${m.name}`;
    }
    if (envelope.mangadexGroupId && envelope.mangadexGroupId !== m.mangadex_group_id) {
      return `mangadex group id ${envelope.mangadexGroupId} does not match manifest ${m.mangadex_group_id}`;
    }

    // Manifest languages, plus the MangaDex codes the operator mapped titles to
    // via `custom_language`.
    //
    // The union is required for correctness, not convenience: `custom_language`
    // exists precisely to publish a title in a language the extension's own
    // catalogue does not name — mangaplus reports SPANISH ("es") for everything,
    // while one title is actually Latin-American Spanish and is mapped to
    // "es-la". Validating against the manifest alone rejected every chapter of
    // that title as "not declared by manifest", which reads as a manifest
    // mistake rather than as the override doing its job.
    //
    // Crucially the map is read from the DATABASE, never from the envelope. The
    // worker also sends `overrideOptions.custom_language`, and trusting that
    // would let a compromised worker widen the very allowlist meant to constrain
    // it. The stored copy is operator-controlled and its values are validated
    // against MANGADEX_LANGUAGES on write, so unioning it in adds no reachable
    // value that an operator did not already choose. This mirrors
    // findExtraChapters, which has always unioned the same map.
    const customLanguages = Object.values(
      (await this.extensionConfig.load(m.name)).custom_language,
    );
    const allowedLanguages = new Set([...m.languages, ...customLanguages]);
    const declared = (): string =>
      `declared: ${[...allowedLanguages].sort().join(", ") || "none"}`;

    for (const language of envelope.extensionLanguages) {
      if (!allowedLanguages.has(language)) {
        return `extension language ${language} not declared by manifest (${declared()})`;
      }
    }

    // The set of MangaDex titles this extension is allowed to speak about.
    // Authoritative, from the database — the same map the worker was handed on
    // lease, so an honest worker can only ever echo back ids that are in here.
    const tracked = new Set(
      (
        await this.prisma.trackedManga.findMany({
          where: { extension: m.name },
          select: { mdMangaId: true },
        })
      ).map((row) => row.mdMangaId),
    );

    const chapters = [...envelope.updatedChapters, ...(envelope.allChapters ?? [])];
    for (const chapter of chapters) {
      if (chapter.chapterUrl && !hostAllowed(chapter.chapterUrl, m.allowed_hosts)) {
        return `chapter url host not in manifest allowed_hosts: ${chapter.chapterUrl}`;
      }
      if (chapter.mangaUrl && !hostAllowed(chapter.mangaUrl, m.allowed_hosts)) {
        return `manga url host not in manifest allowed_hosts: ${chapter.mangaUrl}`;
      }
      if (chapter.chapterLanguage && !allowedLanguages.has(chapter.chapterLanguage)) {
        return `chapter language ${chapter.chapterLanguage} not declared by manifest (${declared()})`;
      }
      // Grouping key for every downstream decision, including removal.
      if (chapter.mdMangaId !== null && !tracked.has(chapter.mdMangaId)) {
        return `chapter names untracked mangadex title ${chapter.mdMangaId}; this extension may only report titles in its tracked map`;
      }
      // A chapter claiming another extension's name would file its bookkeeping
      // (and its uploads) under that extension.
      if (chapter.extensionName !== null && chapter.extensionName !== m.name) {
        return `chapter claims extension ${chapter.extensionName} but the job is ${m.name}`;
      }
    }

    // Consumed by the processor as the candidate set for "tracked on MangaDex
    // but gone upstream" sweeps, i.e. as a removal list.
    for (const id of envelope.trackedMangadexIds) {
      if (!tracked.has(id)) {
        return `envelope claims tracking of untracked mangadex title ${id}`;
      }
    }

    // Untracked-manga reports become MangaDex titles and Discord links, so
    // their urls are attacker-controlled text if unchecked.
    for (const manga of envelope.untrackedManga) {
      if (!hostAllowed(manga.mangaUrl, m.allowed_hosts)) {
        return `untracked manga url host not in manifest allowed_hosts: ${manga.mangaUrl}`;
      }
      if (!allowedLanguages.has(manga.mangaLanguage)) {
        return `untracked manga language ${manga.mangaLanguage} not declared by manifest (${declared()})`;
      }
    }
    return null;
  }

  private priorOutcome(
    state: string,
    submissionId: string,
    rejectReason: string | null,
  ): IngestOutcome {
    switch (state) {
      case "COMMITTED":
        return { outcome: "committed", submissionId };
      case "QUARANTINED":
        return { outcome: "quarantined", submissionId, reason: rejectReason ?? "quarantined" };
      default:
        return { outcome: "superseded", submissionId, reason: rejectReason ?? "superseded" };
    }
  }
}
