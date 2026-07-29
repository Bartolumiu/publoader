import type { PrismaClient, Bundle } from "@prisma/client";
import type { Logger } from "../../logging.js";
import { Manifest } from "../../contracts/manifest.js";
import { metrics } from "../../metrics.js";
import { JobStore } from "../store/jobs.js";
import { BundleStore } from "../store/bundles.js";
import { SettingsStore, AuditLog } from "../store/settings.js";
import { UploadTaskStore } from "../store/uploadTasks.js";
import { computeSegments, dueSlot, effectiveSchedules, slotId } from "./slots.js";

const LAST_TICK_KEY = "scheduler_last_tick";

/**
 * The scheduling loop: turns due schedule slots into durable runs+jobs, and
 * sweeps expired leases. Every action is CAS/idempotent, so running more than
 * one scheduler replica is safe (harmless racing), and a crashed scheduler
 * resumes exactly where the persisted last-tick left off.
 */
export class SchedulerService {
  private readonly jobs: JobStore;
  private readonly bundles: BundleStore;
  private readonly settings: SettingsStore;
  private readonly uploadTasks: UploadTaskStore;
  private readonly audit: AuditLog;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly log: Logger,
    retry: { baseSeconds: number; maxSeconds: number },
  ) {
    this.jobs = new JobStore(prisma, retry);
    this.bundles = new BundleStore(prisma);
    this.settings = new SettingsStore(prisma);
    this.uploadTasks = new UploadTaskStore(prisma);
    this.audit = new AuditLog(prisma);
  }

  /** One scheduler tick. Exposed for tests; the service loop calls it forever. */
  async tick(now = new Date()): Promise<void> {
    metrics.schedulerLagSeconds.set(0);

    if (await this.settings.isPaused()) {
      this.log.debug("scheduler paused; skipping slot creation");
    } else {
      // Isolated deliberately. Slot creation touches bundles, manifests and
      // settings, so it has plenty of ways to throw; letting it abort the tick
      // also skipped the lease sweeper and run advancement below, which is how
      // a single bad manifest could quietly stop the whole queue — visible only
      // as one log line every 30 seconds. Recovery work must not depend on
      // scheduling work succeeding.
      try {
        await this.createDueRuns(now);
      } catch (err) {
        this.log.error({ err }, "creating due runs failed; continuing with sweep and advance");
      }
    }

    const { requeued, deadLettered } = await this.jobs.sweepExpiredLeases();
    for (const job of requeued) {
      metrics.leaseExpiries.inc({ extension: job.extension });
      metrics.jobsRequeued.inc({ extension: job.extension, reason: "lease_expired" });
      this.log.warn({ jobId: job.id, runId: job.runId, attempt: job.attempt }, "lease expired; job requeued");
    }
    for (const job of deadLettered) {
      metrics.jobsDeadLettered.inc({ extension: job.extension });
      this.log.error({ jobId: job.id, runId: job.runId }, "lease expired; attempts exhausted; dead-lettered");
    }

    await this.jobs.advanceRuns();
    const sweptTasks = await this.uploadTasks.sweepExpired();
    if (sweptTasks > 0) {
      this.log.warn({ count: sweptTasks }, "requeued expired upload-task leases");
    }
    await this.updateQueueMetrics();
  }

  private async createDueRuns(now: Date): Promise<void> {
    const lastTickRaw = await this.settings.getSetting(LAST_TICK_KEY);
    // First boot: look back one minute only — never storm through history.
    const lastTick = lastTickRaw ? new Date(lastTickRaw) : new Date(now.getTime() - 60_000);

    const bundles = await this.bundles.listLatest();
    const manifests = bundles
      .map((b) => {
        const parsed = Manifest.safeParse(b.manifest);
        return parsed.success ? { manifest: parsed.data, bundle: b } : null;
      })
      .filter((x): x is { manifest: Manifest; bundle: Bundle } => x !== null);

    const overrides = await this.settings.getScheduleOverrides();
    const disabled = await this.settings.listDisabled();
    const schedules = effectiveSchedules(
      manifests.map((m) => m.manifest),
      overrides,
      disabled,
    );

    for (const schedule of schedules) {
      const due = dueSlot(schedule, lastTick, now);
      if (!due) continue;
      const entry = manifests.find((m) => m.manifest.name === schedule.extension);
      if (!entry) continue;
      await this.createRunForExtension(entry.manifest, entry.bundle, {
        idempotencyKey: `sched:${schedule.extension}:${slotId(due)}`,
        kind: "UPDATE",
        triggeredBy: "scheduler",
        scheduledFor: due,
      });
    }

    await this.settings.setSetting(LAST_TICK_KEY, now.toISOString());
  }

  /** Shared by the scheduler and the admin run-now endpoint. */
  async createRunForExtension(
    manifest: Manifest,
    bundle: Bundle,
    opts: {
      idempotencyKey: string;
      kind: "UPDATE" | "CLEAN" | "FORCE";
      triggeredBy: string;
      scheduledFor?: Date;
    },
  ): Promise<{ runId: string; created: boolean; segments: number }> {
    let segments: ReturnType<typeof computeSegments> = [];
    // CLEAN runs are all-or-nothing over the full catalogue; never partition
    // them — a missing segment must not read as "chapters were removed".
    if (manifest.partition && opts.kind !== "CLEAN") {
      // The DB (TrackedManga) is the source of truth for the tracked catalogue
      // — bundle data files only seed it at publish time.
      const tracked = await this.prisma.trackedManga.findMany({
        where: { extension: manifest.name },
        select: { mangaId: true },
      });
      const mangaIds = tracked.map((t) => t.mangaId);
      segments = computeSegments(manifest.name, opts.idempotencyKey, mangaIds, {
        maxSegments: manifest.partition.maxSegments,
        minMangaPerSegment: manifest.partition.minMangaPerSegment,
      });
    }

    const { run, created } = await this.jobs.createRun({
      idempotencyKey: opts.idempotencyKey,
      extension: manifest.name,
      extensionVersion: manifest.version,
      bundleSha256: bundle.sha256,
      kind: opts.kind,
      triggeredBy: opts.triggeredBy,
      scheduledFor: opts.scheduledFor,
      timeoutSeconds: manifest.timeout_seconds,
      maxAttempts: manifest.max_attempts,
      minTrust: manifest.min_trust,
      segments,
    });
    if (created) {
      metrics.jobsCreated.inc(
        { extension: manifest.name, kind: opts.kind },
        Math.max(1, segments.length),
      );
      this.log.info(
        { runId: run.id, extension: manifest.name, kind: opts.kind, segments: Math.max(1, segments.length) },
        "run created",
      );
      await this.audit.record("scheduler", "run.create", run.id, {
        extension: manifest.name,
        kind: opts.kind,
        idempotencyKey: opts.idempotencyKey,
      });
    }
    return { runId: run.id, created, segments: Math.max(1, segments.length) };
  }

  private async updateQueueMetrics(): Promise<void> {
    const jobCounts = await this.prisma.job.groupBy({ by: ["state"], _count: true });
    for (const row of jobCounts) {
      metrics.jobQueueDepth.set({ state: row.state }, row._count);
    }
    const depths = await this.uploadTasks.depths();
    for (const d of depths) {
      metrics.uploadTasks.set({ kind: d.kind, state: d.state }, d.count);
    }
    const workerCounts = await this.prisma.worker.groupBy({ by: ["status"], _count: true });
    for (const row of workerCounts) {
      metrics.workersByStatus.set({ status: row.status }, row._count);
    }
  }
}
