import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
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

/**
 * Content types the dashboard directory may serve. The allowlist is by
 * EXTENSION, and the file list is discovered from the directory at startup, so
 * splitting the SPA into several modules needs no change here; but a file type
 * that is not a page, a script or a stylesheet still cannot be served, and no
 * request path is ever joined onto a filesystem path.
 */
const ASSET_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

/** Must exist; anything else in the directory is optional. */
const REQUIRED_ASSETS = ["index.html", "app.js", "style.css"] as const;

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
  const dir = fileURLToPath(new URL("./dashboard/", import.meta.url));

  // Read the directory ONCE at startup and serve only what was found then.
  // Requests are matched against this map by exact basename, so a request can
  // never address a file by path; traversal is not filtered, it is impossible.
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const contentType = ASSET_TYPES[extname(entry.name).toLowerCase()];
    if (!contentType) continue;
    assets.set(entry.name, { body: readFileSync(join(dir, entry.name)), contentType });
  }

  const missing = REQUIRED_ASSETS.filter((name) => !assets.has(name));
  if (missing.length > 0) {
    // A dashboard that boots without its own scripts serves a blank page and
    // looks like an auth problem, so fail loudly at startup instead.
    throw new Error(
      `dashboard assets missing from ${dir}: ${missing.join(", ")}. ` +
        "The build must copy src/core/api/dashboard alongside the compiled output " +
        "(see the `build` script in package.json).",
    );
  }
  return assets;
}

/**
 * The dashboard is the site: it answers "/" so publoader.ardax.dev lands on
 * the sign-in page, with /dash kept as an alias.
 *
 * Only exact, enumerated routes are claimed, "/", "/dash", "/dash/*", so the
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
