import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import Fastify from "fastify";

/**
 * The build stamp the dashboard shows.
 *
 * Workers reported `agentVersion: "1.0.0"` for the platform's whole life — a
 * default string in the `CoreApiClient` constructor that no caller overrode and
 * no release bumped. The fix replaces it with `PUBLOADER_BUILD`, baked into the
 * image, and puts the same value in the sidebar so the two can be compared. That
 * comparison is only worth anything if the number on the page is real, so this
 * asserts the substitution actually happens rather than that a placeholder is
 * present.
 *
 * The env var is set before the dynamic import because `VERSION` is resolved at
 * module load; a static import would hoist above the assignment and read `dev`.
 */
const INDEX_HTML = fileURLToPath(
  new URL("../../src/core/api/dashboard/index.html", import.meta.url),
);
const BUILD = "9.9.9+dEadBe3";

async function serveIndex(): Promise<string> {
  process.env["PUBLOADER_BUILD"] = BUILD;
  const { registerDashboardRoutes } = await import("../../src/core/api/dashboard.js");
  const app = Fastify();
  registerDashboardRoutes(app);
  await app.ready();
  try {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    return res.body;
  } finally {
    await app.close();
  }
}

describe("dashboard build stamp", () => {
  it("substitutes the running build into the served page", async () => {
    const body = await serveIndex();
    expect(body).toContain(BUILD);
    // The failure this guards is a page that ships the placeholder verbatim,
    // which reads as a version to nobody and would otherwise go unnoticed.
    expect(body).not.toContain("__BUILD__");
  });

  it("keeps the placeholder in the source file the server substitutes into", () => {
    // Renaming the token on one side only would leave the served page showing
    // the literal placeholder, and the test above is what would catch it — but
    // only if the two spellings are checked against each other explicitly.
    expect(readFileSync(INDEX_HTML, "utf8")).toContain("__BUILD__");
  });
});
