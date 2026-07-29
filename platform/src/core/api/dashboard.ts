import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply } from "fastify";

/**
 * Static operator dashboard, served from the API process itself so there is
 * one origin, one deployment, and no CORS surface.
 *
 * The assets are plain files with no build step; they are read once at boot,
 * which keeps request handling off the filesystem. `import.meta.url`
 * resolution means the same code path works from `src/` under vitest/tsx and
 * from `dist/` in the container, provided the build copies `dashboard/`
 * alongside this module (see the `build` script in package.json).
 */

const ASSETS = [
  ["index.html", "text/html; charset=utf-8"],
  ["app.js", "text/javascript; charset=utf-8"],
  ["style.css", "text/css; charset=utf-8"],
] as const;

/**
 * No inline scripts or styles, no external origins, and the page may not be
 * framed. `connect-src 'self'` keeps a tampered asset from exfiltrating the
 * admin data it can read.
 */
export const DASHBOARD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join("; ");

function loadAssets(): Map<string, { body: Buffer; contentType: string }> {
  const assets = new Map<string, { body: Buffer; contentType: string }>();
  for (const [name, contentType] of ASSETS) {
    const path = fileURLToPath(new URL(`./dashboard/${name}`, import.meta.url));
    assets.set(name, { body: readFileSync(path), contentType });
  }
  return assets;
}

/**
 * The dashboard is the site: it answers "/" so publoader.ardax.dev lands on
 * the sign-in page, with /dash kept as an alias.
 *
 * Only exact, enumerated routes are claimed — "/", "/dash", "/dash/*" — so the
 * dashboard can never shadow /healthz, /readyz, /metrics or the API
 * namespaces. Those are registered separately and remain internal-network
 * paths. In particular there is no root-level wildcard: an unknown top-level
 * path still 404s rather than silently returning HTML.
 */
export function registerDashboardRoutes(app: FastifyInstance): void {
  const assets = loadAssets();

  const send = (reply: FastifyReply, name: string): FastifyReply => {
    const asset = assets.get(name)!;
    return reply
      .header("content-type", asset.contentType)
      .header("content-security-policy", DASHBOARD_CSP)
      .header("x-frame-options", "DENY")
      .send(asset.body);
  };

  app.get("/", async (_req, reply) => send(reply, "index.html"));
  app.get("/dash", async (_req, reply) => send(reply, "index.html"));

  // Unknown sub-paths fall back to the shell: the dashboard is a single page
  // and a stale bookmark should land on it rather than a 404.
  app.get("/dash/*", async (req, reply) => {
    const rest = (req.params as { "*": string })["*"];
    return send(reply, assets.has(rest) ? rest : "index.html");
  });
}
