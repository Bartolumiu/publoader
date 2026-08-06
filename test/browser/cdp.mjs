/**
 * Dependency-free Chrome DevTools Protocol driver.
 *
 * A real engine is required for anything about visibility: jsdom does not
 * implement cascade origin precedence, so it reports `display: none` for a
 * `hidden` element that Chrome, Firefox and Safari all still paint.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export async function launch({ port = 9222 + Math.floor(Math.random() * 500) } = {}) {
  const profile = mkdtempSync(join(tmpdir(), "dash-cdp-"));
  const child = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-gpu",
      "--window-size=1400,900",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      const v = await (await fetch(`${base}/json/version`)).json();
      if (v.webSocketDebuggerUrl) break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  const browser = {
    base,
    async close() {
      child.kill("SIGKILL");
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch {}
    },
    async newPage(url = "about:blank", { width = 1400, height = 900 } = {}) {
      const res = await fetch(`${base}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
      const target = await res.json();
      return connect(target.webSocketDebuggerUrl, { width, height });
    },
  };
  return browser;
}

async function connect(wsUrl, viewport) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });

  let next = 1;
  const pending = new Map();
  const events = [];
  const listeners = new Set();
  ws.addEventListener("message", (msg) => {
    const data = JSON.parse(msg.data);
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) reject(new Error(`${data.error.message} (${JSON.stringify(data.error.data ?? "")})`));
      else resolve(data.result);
      return;
    }
    events.push(data);
    for (const fn of listeners) fn(data);
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = next++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  const page = {
    send,
    events,
    onEvent(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** Console messages and page errors, collected for the whole session. */
    consoleLines: [],
    async ready() {
      await send("Page.enable");
      await send("Runtime.enable");
      await send("Log.enable");
      await send("Network.enable");
      // Headless Chrome has no OS focus, and Element.focus() is a no-op in an
      // unfocused document; which makes every focus assertion vacuously false.
      await send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
      await send("Emulation.setDeviceMetricsOverride", {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      page.onEvent((e) => {
        if (e.method === "Runtime.consoleAPICalled") {
          page.consoleLines.push(
            `${e.params.type}: ${e.params.args.map((a) => a.value ?? a.description ?? a.type).join(" ")}`,
          );
        }
        if (e.method === "Runtime.exceptionThrown") {
          page.consoleLines.push(
            `pageerror: ${e.params.exceptionDetails.exception?.description ?? e.params.exceptionDetails.text}`,
          );
        }
        if (e.method === "Log.entryAdded" && e.params.entry.level === "error") {
          page.consoleLines.push(`log: ${e.params.entry.text}`);
        }
      });
      return page;
    },
    /**
     * Navigate and wait for load plus a settle window for the SPA's own fetches.
     *
     * A hash-only change within the same document does not fire a load event, so
     * it is driven the way a clicked link would drive it; which is also what the
     * router is supposed to handle.
     */
    async goto(url, settle = 900) {
      const target = new URL(url);
      const here = await send("Runtime.evaluate", { expression: "location.href", returnByValue: true });
      const current = here.result.value ? new URL(here.result.value) : null;
      const sameDocument =
        current &&
        target.origin === current.origin &&
        target.pathname === current.pathname &&
        target.search === current.search &&
        target.hash !== current.hash;

      if (current && target.href === current.href) {
        // Navigating to the identical URL is a no-op that fires no load event.
        const loaded = page.once("Page.loadEventFired");
        await send("Page.reload", { ignoreCache: false });
        await loaded;
      } else if (sameDocument) {
        await page.eval(`location.hash = ${JSON.stringify(target.hash)}; return true;`);
      } else {
        const loaded = page.once("Page.loadEventFired");
        await send("Page.navigate", { url });
        await loaded;
      }
      await page.settle(settle);
    },
    async reload(settle = 900) {
      const loaded = page.once("Page.loadEventFired");
      await send("Page.reload", { ignoreCache: false });
      await loaded;
      await page.settle(settle);
    },
    once(method, timeout = 15000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          off();
          reject(new Error(`timed out waiting for ${method}`));
        }, timeout);
        const off = page.onEvent((e) => {
          if (e.method === method) {
            clearTimeout(timer);
            off();
            resolve(e.params);
          }
        });
      });
    },
    settle(ms = 400) {
      return new Promise((r) => setTimeout(r, ms));
    },
    /**
     * Evaluate an expression in the page and return a structured clone. This is
     * `Runtime.evaluate`, the debugger's own console: the expressions come from
     * the test files in this directory, never from the page or the network.
     */
    async eval(expression) {
      const res = await send("Runtime.evaluate", {
        expression: `(async () => { ${expression} })()`,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      if (res.exceptionDetails) {
        throw new Error(
          `page eval threw: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`,
        );
      }
      return res.result.value;
    },
    /** Wait until `expression` returns truthy, or throw. */
    async waitFor(expression, { timeout = 12000, every = 120, label = expression } = {}) {
      const deadline = Date.now() + timeout;
      for (;;) {
        if (await page.eval(`return Boolean(${expression});`)) return true;
        if (Date.now() > deadline) throw new Error(`waitFor timed out: ${label}`);
        await page.settle(every);
      }
    },
    async close() {
      ws.close();
    },
  };
  return page.ready();
}

let failures = 0;
export function ok(label, cond, extra = "") {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? ` ; ${extra}` : ""}`);
  return cond;
}
export const failureCount = () => failures;
