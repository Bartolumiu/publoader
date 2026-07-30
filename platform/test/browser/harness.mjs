/**
 * jsdom harness for the publoader dashboard.
 *
 * jsdom has no fetch, no dialog and no real navigation, so each of those is
 * supplied here: fetch proxies to Node's, carrying cookies in a jar so the
 * session cookie behaves the way a browser's would.
 */
import { JSDOM, VirtualConsole } from "jsdom";

export const ORIGIN = process.env.DASH_ORIGIN ?? "http://127.0.0.1:8101";

export async function boot({ hash = "", origin = ORIGIN } = {}) {
  const errs = [];
  const logs = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errs.push("jsdomError: " + (e.stack || e.message)));
  for (const level of ["error", "warn", "log"]) {
    vc.on(level, (...a) => logs.push(`${level}: ${a.map(String).join(" ")}`));
  }

  const html = await (await fetch(`${origin}/`)).text();
  const dom = new JSDOM(html, {
    url: `${origin}/${hash}`,
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  const { window } = dom;

  const jar = new Map();
  window.fetch = async (url, init = {}) => {
    const abs = new URL(String(url), origin).toString();
    const headers = new Headers(init.headers || {});
    if (jar.size) headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await fetch(abs, { ...init, headers, redirect: "manual" });
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const [pair] = sc.split(";");
      const i = pair.indexOf("=");
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      if (/max-age=0|expires=thu, 01 jan 1970/i.test(sc)) jar.delete(name);
      else jar.set(name, value);
    }
    return res;
  };
  window.Headers = Headers;
  window.Request = Request;
  window.Response = Response;
  // Destructive confirmations are auto-accepted; the tests that care assert the
  // request that followed rather than the prompt.
  window.confirm = () => true;
  if (!window.HTMLDialogElement.prototype.showModal) {
    window.HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    window.HTMLDialogElement.prototype.close = function () {
      this.open = false;
    };
  }
  window.navigator.clipboard = { writeText: async () => {}, readText: async () => "" };

  // Documented in jsdom as unimplemented; several views call it after render.
  window.Element.prototype.scrollIntoView = function () {};

  const src = await (await fetch(`${origin}/dash/app.js`)).text();
  window.eval(src);

  const api = {
    window,
    dom,
    jar,
    errs,
    logs,
    $: (id) => window.document.getElementById(id),
    q: (sel) => window.document.querySelector(sel),
    qa: (sel) => [...window.document.querySelectorAll(sel)],
    text: (sel) => api.q(sel)?.textContent?.trim() ?? null,
    click(node) {
      node.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    },
    submit(form) {
      form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    },
    async settle(ms = 700) {
      await new Promise((r) => setTimeout(r, ms));
    },
    navigate(h) {
      const before = window.location.hash;
      // jsdom does not fire hashchange for a programmatic hash assignment on a
      // document created from a string, so it is dispatched explicitly.
      window.location.hash = h;
      if (window.location.hash !== before) {
        window.dispatchEvent(new window.HashChangeEvent("hashchange"));
      }
    },
    close() {
      window.close();
    },
  };
  return api;
}

export function ok(label, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? `  — ${extra}` : ""}`);
  if (!cond) process.exitCode = 1;
  return cond;
}
