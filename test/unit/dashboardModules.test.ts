// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The two dashboard views that live in their own ES modules.
 *
 * Why this file exists: `dashboard/sysops.js` and `dashboard/docs.js` are loaded
 * by `app.js` at runtime through `import()`, and are handed a `host` object that
 * `app.js` builds. Nothing checked that boundary. The server-side dashboard tests
 * assert the files are *served*; they never execute them, so a view that throws
 * on open, or reads a capability the host does not pass, would ship green; and
 * the operator would see the shell's "This view could not be loaded" card with no
 * test having failed. That is the whole gap being closed here.
 *
 * The host below deliberately mirrors `moduleHost()` in app.js EXACTLY, including
 * what it leaves out. `confirm` is the one that matters: app.js does not pass it,
 * because these views call it synchronously (`if (!confirm(msg)) return;`) while
 * the shell's own `confirmDialog` returns a promise, which is always truthy;
 * passing it would turn every confirmation in these views into a no-op that
 * always proceeds. So the omission is load-bearing, and a test that helpfully
 * supplied `confirm` would be testing a host that does not exist.
 */

/**
 * DOM access goes through these locals rather than through ambient globals.
 *
 * The `jsdom` environment supplies the real globals at runtime; the reason not to
 * *type* them is that the only ways to do so, adding "dom" to tsconfig's `lib`,
 * or a `/// <reference lib="dom" />` here, apply to the whole program, and the
 * DOM's `fetch` signature then conflicts with Node's in `src/cli/admin.ts`.
 * Worse, it would stop the server-side sources failing to compile when they reach
 * for a browser global by mistake, which is a check worth keeping. So the DOM is
 * loosely typed in this one file, deliberately.
 */
/* eslint-disable @typescript-eslint/no-explicit-any --
   The `any`s below are the deliberate consequence of keeping the DOM lib out of
   this program, explained above. Disabled for these three declarations only, so
   a stray `any` anywhere else in the file is still reported. */
type El = any;
const doc: any = (globalThis as any).document;
const win: any = globalThis;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Is this a DOM node? Duck-typed, since `Node` is not in scope here. */
const isNode = (value: unknown): boolean =>
  typeof (value as { nodeType?: unknown } | null)?.nodeType === "number";

/** Minimal stand-in for app.js's `el`, with the same null-skipping behaviour. */
function el(tag: string, attrs?: Record<string, unknown>, ...kids: unknown[]): El {
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = String(value);
    else if (key === "text") node.textContent = String(value);
    else if (key === "style") Object.assign(node.style, value as object);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value as (event: unknown) => void);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const kid of kids.flat(4)) {
    if (kid == null || kid === false || kid === "") continue;
    node.append(
      isNode(kid) ? (kid as El) : doc.createTextNode(String(kid)),
    );
  }
  return node;
}

/** Endpoint → payload. Shapes copied from the route handlers, not invented. */
const RESPONSES: Record<string, unknown> = {
  "/sysops/github/status": {
    configured: true,
    tokenPresent: true,
    extensions: [
      { extension: "mangaplus", state: "behind", publishedCommit: "a".repeat(40), headCommit: "b".repeat(40), changedPaths: ["src/mangaplus/index.ts"] },
      { extension: "viz", state: "current", publishedCommit: "c".repeat(40), headCommit: "c".repeat(40), changedPaths: [] },
    ],
  },
  "/docs": {
    available: true,
    documents: [
      { name: "operations.md", title: "Operations", bytes: 41_000 },
      { name: "data-model.md", title: "Data model", bytes: 22_000 },
    ],
  },
  "/docs/operations.md": { name: "operations.md", markdown: "# Operations\n\nA paragraph.\n" },
};

const calls: string[] = [];

/** Exactly the keys app.js's moduleHost() provides; no more. */
function moduleHost() {
  return {
    el,
    selectTab: vi.fn(),
    api: async (path: string) => {
      calls.push(path);
      const key = Object.keys(RESPONSES).find((k) => path.startsWith(k));
      if (key) return RESPONSES[key];
      throw new Error(`unstubbed endpoint ${path}`);
    },
    card: (title: string, ...kids: unknown[]) =>
      el("div", { class: "card" }, title ? el("h2", { text: title }) : null, ...kids),
    row: (...kids: unknown[]) => el("div", { class: "row" }, ...kids),
    table: (headers: string[], rows: unknown[][]): El =>
      el(
        "table",
        {},
        el("tr", {}, ...headers.map((h) => el("th", { text: h }))),
        // Rows are rendered, not dropped: a view that puts its content in cells
        // would otherwise look empty to every assertion here.
        ...rows.map((cells) => el("tr", {}, ...cells.map((cell) => el("td", {}, cell)))),
      ),
    chip: (text: string) => el("span", { class: "chip", text }),
    defs: (pairs: [string, unknown][]) =>
      el("dl", {}, ...pairs.flatMap(([k, v]) => [el("dt", { text: k }), el("dd", { text: String(v) })])),
    toast: vi.fn(),
    can: () => true,
  };
}

describe("dashboard module views", () => {
  beforeEach(() => {
    calls.length = 0;
    doc.body.replaceChildren();
  });

  it("viewSysops renders a node against the host app.js actually passes", async () => {
    const { viewSysops } = await import("../../src/core/api/dashboard/sysops.js");
    const node = await viewSysops(moduleHost());

    // app.js does `host.replaceChildren(node)`, so anything but a Node paints
    // the string "undefined" or throws.
    expect(isNode(node), "a view must return a DOM node").toBe(true);
    doc.body.append(node);
    expect(doc.body.textContent?.trim()).not.toBe("");
  });

  it("viewSysops offers the four maintenance actions the dashboard promises", async () => {
    const { viewSysops } = await import("../../src/core/api/dashboard/sysops.js");
    doc.body.append(await viewSysops(moduleHost()));
    const text = doc.body.textContent ?? "";

    // These are the buttons the operator was told they would get, and the reason
    // this view exists: never needing a shell on the host.
    for (const promise of ["GitHub", "Restart", "Upload", "docs"]) {
      expect(text.toLowerCase(), `no sign of "${promise}"`).toContain(promise.toLowerCase());
    }
    expect(doc.body.querySelectorAll("button").length).toBeGreaterThan(3);
  });

  it("viewDocs renders the shipped document list", async () => {
    const { viewDocs } = await import("../../src/core/api/dashboard/docs.js");
    doc.body.append(await viewDocs(moduleHost()));

    expect(calls).toContain("/docs");
    expect(doc.body.textContent).toContain("Operations");
    expect(doc.body.textContent).toContain("Data model");
  });

  it("viewDocs explains an empty docs directory instead of showing nothing", async () => {
    // The fix is a build argument, and the operator is the one who can apply it,
    // so "no documents" must say why rather than render an empty panel.
    const { viewDocs } = await import("../../src/core/api/dashboard/docs.js");
    const host = moduleHost();
    host.api = async () => ({ available: false, documents: [], reason: "docs/ was not copied into the image" });
    doc.body.append(await viewDocs(host));

    expect(doc.body.textContent).toContain("docs/ was not copied into the image");
  });

  it("viewSysops needs no API call to render, so GitHub being down costs nothing", async () => {
    // Maintenance draws its controls first and fetches only when asked; opening
    // the page does not reach out to GitHub, and an unreachable core-api or a
    // missing GITHUB_TOKEN still leaves every other action on the page usable.
    const { viewSysops } = await import("../../src/core/api/dashboard/sysops.js");
    const host = moduleHost();
    host.api = async () => {
      throw new Error("core-api is unreachable");
    };

    const node = await viewSysops(host);
    expect(isNode(node), "a view must return a DOM node").toBe(true);
    expect(calls, "rendering Maintenance should not call the API").toEqual([]);

    const probe = el("div", {}, node);
    // Says it has not looked yet, rather than implying everything is current.
    expect(probe.textContent).toContain("Not checked yet");
    expect(probe.querySelectorAll("button").length).toBeGreaterThan(3);
  });

  it("viewDocs surfaces the real API error instead of throwing into the shell", async () => {
    // viewDocs does fetch during render, so it owns the failure. A throw would
    // reach app.js's catch and replace the panel with the generic "could not be
    // loaded" card, losing the reason the operator needs.
    const { viewDocs } = await import("../../src/core/api/dashboard/docs.js");
    const host = moduleHost();
    host.api = async () => {
      throw new Error("core-api is unreachable");
    };

    const node = await viewDocs(host);
    expect(isNode(node), "a view must return a DOM node").toBe(true);
    expect(el("div", {}, node).textContent).toContain("core-api is unreachable");
  });

  it("neither view depends on a host.confirm that app.js does not pass", async () => {
    // The load-bearing omission. These views must fall back to window.confirm,
    // which actually blocks; a promise-returning confirm is always truthy and
    // would silently remove the guard on restart and publish.
    const host = moduleHost();
    expect(host, "moduleHost must not grow a confirm key").not.toHaveProperty("confirm");

    const sysops = await import("../../src/core/api/dashboard/sysops.js");
    const node = await sysops.viewSysops(host);
    expect(isNode(node), "a view must return a DOM node").toBe(true);

    // Prove the fallback is reached and is refusable: a declined confirm must
    // stop the action, so nothing is POSTed.
    const confirmSpy = vi.spyOn(win, "confirm").mockReturnValue(false);
    doc.body.append(node);
    const buttons: El[] = Array.from(doc.body.querySelectorAll("button"));
    const restart = buttons.find((b) => /restart/i.test(b.textContent ?? ""));
    expect(restart, "no restart button to test the guard on").toBeDefined();

    calls.length = 0;
    restart!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(confirmSpy).toHaveBeenCalled();
    expect(calls, "a declined confirmation still called the API").not.toContain("/sysops/restart");
    confirmSpy.mockRestore();
  });
});
