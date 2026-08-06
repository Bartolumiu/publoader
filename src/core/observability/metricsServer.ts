import { createServer, type Server } from "node:http";
import type { Logger } from "../../logging.js";
import { renderMetrics } from "../../metrics.js";

/**
 * The metrics/health listener for the worker-style core services
 * (core-scheduler, core-processor, core-uploader).
 *
 * WHY this exists: prom-client's registry is per-process. Every metric those
 * three services record; scheduler ticks, dead-letter depth, upload queue
 * depth; used to live in a registry no one could reach, because only core-api
 * had a socket. The numbers were computed and then thrown away, so a wedged
 * scheduler or a stalled upload queue was undetectable from outside.
 *
 * One implementation, three services, identical route semantics to core-api
 * (src/core/api/server.ts) so an operator does not have to remember which
 * service answers what:
 *
 *   GET /metrics  Prometheus text from this process's registry.
 *   GET /healthz  "alive": the process is running and its event loop turns.
 *                 This is the container healthcheck.
 *   GET /readyz   "safe to work": Postgres answers. Deliberately NOT the
 *                 container healthcheck; a Postgres restart must not cascade
 *                 into killing every core service.
 *
 * All three are unauthenticated and must stay on the internal compose network
 * (`expose:`, never `ports:`, and blocked at the edge): /metrics leaks fleet
 * and queue topology.
 */

/** Just the slice of PrismaClient readiness needs, so tests can pass a stub. */
export interface ReadinessProbe {
  $queryRawUnsafe(query: string): Promise<unknown>;
}

export interface MetricsServerOptions {
  /** Service name, for log lines only. */
  service: string;
  log: Logger;
  /** Readiness dependency; `null` means "no database, report alive only". */
  prisma: ReadinessProbe | null;
  /** Used when METRICS_PORT is unset. Distinct per service; see compose. */
  defaultPort: number;
  /** Overrides for tests; production reads HOST/METRICS_PORT. */
  host?: string;
  port?: number;
}

export interface MetricsServer {
  /** The bound port; resolved, so a test can pass 0 and still connect. */
  readonly port: number;
  close(): Promise<void>;
}

function resolvePort(opts: MetricsServerOptions): number {
  if (opts.port !== undefined) return opts.port;
  const raw = process.env["METRICS_PORT"];
  if (raw !== undefined && raw !== "") {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
      throw new Error(`METRICS_PORT is not a valid port: ${raw}`);
    }
    return parsed;
  }
  return opts.defaultPort;
}

/**
 * Bind the listener. Rejects if the port cannot be bound: a service that
 * silently failed to expose its metrics would be indistinguishable from a
 * healthy one, which is the failure this whole module exists to remove. Start
 * it before entering the service's work loop so a misconfigured port is a loud
 * boot failure rather than months of blind operation.
 */
export async function startMetricsServer(opts: MetricsServerOptions): Promise<MetricsServer> {
  const host = opts.host ?? process.env["HOST"] ?? "0.0.0.0";
  const port = resolvePort(opts);

  const server: Server = createServer((req, res) => {
    const send = (status: number, body: string, contentType = "application/json") => {
      res.writeHead(status, {
        "content-type": contentType,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      res.end(body);
    };

    const path = new URL(req.url ?? "/", "http://localhost").pathname;

    if (req.method !== "GET" && req.method !== "HEAD") {
      send(405, JSON.stringify({ error: "method not allowed" }));
      return;
    }

    void (async () => {
      try {
        if (path === "/metrics") {
          send(200, await renderMetrics(), "text/plain; version=0.0.4");
          return;
        }
        if (path === "/healthz") {
          send(200, JSON.stringify({ ok: true, service: opts.service }));
          return;
        }
        if (path === "/readyz") {
          if (opts.prisma === null) {
            send(200, JSON.stringify({ ok: true, service: opts.service }));
            return;
          }
          try {
            await opts.prisma.$queryRawUnsafe("SELECT 1");
          } catch {
            send(503, JSON.stringify({ ok: false, reason: "database unreachable" }));
            return;
          }
          send(200, JSON.stringify({ ok: true, service: opts.service }));
          return;
        }
        send(404, JSON.stringify({ error: "not found" }));
      } catch (err) {
        opts.log.error({ err, path }, "metrics endpoint failed");
        if (!res.headersSent) send(500, JSON.stringify({ error: "internal error" }));
        else res.end();
      }
    })();
  });

  // A scraper that vanishes mid-request must not hold a socket open past
  // shutdown, and a half-open connection must not delay `close()`.
  server.keepAliveTimeout = 5_000;
  server.headersTimeout = 10_000;

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.removeListener("listening", onListening);
      reject(new Error(`${opts.service}: cannot bind metrics listener on ${host}:${port}`, { cause: err }));
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

  const address = server.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : port;
  opts.log.info(
    { host, port: boundPort, endpoints: ["/metrics", "/healthz", "/readyz"] },
    `${opts.service} metrics listener started`,
  );

  return {
    port: boundPort,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
