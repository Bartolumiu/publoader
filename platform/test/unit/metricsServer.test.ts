import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../../src/logging.js";
import {
  startMetricsServer,
  type MetricsServer,
  type ReadinessProbe,
} from "../../src/core/observability/metricsServer.js";
import { markSchedulerTick, metrics, registry } from "../../src/metrics.js";
import {
  heartbeatPath,
  resetHeartbeatThrottleForTests,
  touchHeartbeat,
} from "../../src/core/observability/heartbeat.js";

const log = createLogger("test", "error");

const reachable: ReadinessProbe = { $queryRawUnsafe: async () => [{ "?column?": 1 }] };
const unreachable: ReadinessProbe = {
  $queryRawUnsafe: async () => {
    throw new Error("connection refused");
  },
};

let server: MetricsServer | undefined;

async function start(prisma: ReadinessProbe | null): Promise<string> {
  server = await startMetricsServer({
    service: "test-service",
    log,
    prisma,
    defaultPort: 0,
    host: "127.0.0.1",
    port: 0,
  });
  return `http://127.0.0.1:${server.port}`;
}

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("metrics server", () => {
  it("serves the shared registry on /metrics", async () => {
    metrics.deadLetterJobs.set(3);
    const base = await start(reachable);

    const res = await fetch(`${base}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    // Prometheus exposition, not an accidental JSON body.
    expect(body).toContain("# HELP publoader_dead_letter_jobs");
    expect(body).toContain("publoader_dead_letter_jobs 3");
  });

  it("separates liveness from readiness", async () => {
    const base = await start(reachable);

    const alive = await fetch(`${base}/healthz`);
    expect(alive.status).toBe(200);
    expect(await alive.json()).toEqual({ ok: true, service: "test-service" });

    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(200);
  });

  it("fails readiness — but not liveness — when the database is unreachable", async () => {
    const base = await start(unreachable);

    expect((await fetch(`${base}/healthz`)).status).toBe(200);

    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({ ok: false, reason: "database unreachable" });
  });

  it("exposes nothing else", async () => {
    const base = await start(reachable);

    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/api/v1/admin/stats`)).status).toBe(404);
    expect((await fetch(`${base}/metrics`, { method: "POST" })).status).toBe(405);
  });

  it("refuses to start twice on the same port rather than run unmonitored", async () => {
    const base = await start(reachable);
    const port = Number(new URL(base).port);

    await expect(
      startMetricsServer({
        service: "second",
        log,
        prisma: reachable,
        defaultPort: 0,
        host: "127.0.0.1",
        port,
      }),
    ).rejects.toThrow(/cannot bind metrics listener/);
  });
});

describe("scheduler tick timestamp", () => {
  it("records a unix timestamp a scraper can subtract from time()", async () => {
    const at = new Date("2026-07-29T12:00:00.000Z");
    markSchedulerTick(at);

    const value = await registry.getSingleMetricAsString(
      "publoader_scheduler_last_tick_timestamp_seconds",
    );
    expect(value).toContain(`${at.getTime() / 1000}`);
  });

  it("no longer exports the lag gauge that could not report a stall", async () => {
    // The old gauge read 0 both when healthy and when wedged, because only the
    // code that had stopped running could have raised it. It is gone entirely —
    // not shimmed — so neither the metric nor a call site for it exists.
    expect("schedulerLagSeconds" in metrics).toBe(false);
    const body = await registry.metrics();
    expect(body).not.toContain("publoader_scheduler_lag_seconds");
  });
});

describe("worker heartbeat", () => {
  it("writes a fresh file and coalesces rapid touches", () => {
    const dir = mkdtempSync(join(tmpdir(), "publoader-hb-"));
    resetHeartbeatThrottleForTests();

    touchHeartbeat(dir);
    const path = heartbeatPath(dir);
    expect(readFileSync(path, "utf8").trim()).not.toBe("");

    // Backdate, then touch again inside the coalescing window: unchanged.
    const stale = new Date("2020-01-01T00:00:00.000Z");
    utimesSync(path, stale, stale);
    touchHeartbeat(dir);
    expect(statSync(path).mtimeMs).toBe(stale.getTime());

    // Past the window it must write again — freshness is the whole probe.
    touchHeartbeat(dir, Date.now() + 60_000);
    expect(statSync(path).mtimeMs).toBeGreaterThan(stale.getTime());
  });
});
