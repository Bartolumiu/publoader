/*
 * publoader operator dashboard.
 *
 * Vanilla ES modules-free JavaScript, no build step, no dependencies. Runs
 * under a CSP with no 'unsafe-inline', so every handler is attached with
 * addEventListener and every value is written with textContent — there is no
 * innerHTML anywhere in this file, which is what keeps operator-supplied
 * strings (extension names, worker names, error text) from becoming script.
 *
 * Authentication is the session cookie set by POST /api/v1/admin/session; the
 * admin token is never held in JS beyond the login submit.
 *
 * What the page offers is decided by GET /api/v1/admin/whoami: every tab names
 * the scope its view needs, and every control that mutates something is either
 * absent or visibly disabled without the scope behind it. That is presentation
 * only — the server checks the same scopes on every request, and the integration
 * suite asserts the refusals rather than trusting this file.
 */

"use strict";

const API = "/api/v1/admin";
const CSRF_HEADER = "x-requested-with";
const CSRF_VALUE = "publoader-dash";
const REFRESH_MS = 10_000;
const WILDCARD = "*";

const state = {
  actor: null,
  role: null,
  userId: null,
  tab: "overview",
  timer: null,
  /** Scope set from GET /whoami. Empty until it answers. */
  scopes: [],
  /** "root" | "api-token" | "session". */
  kind: null,
};

/**
 * Does the signed-in principal hold `required`?
 *
 * This mirrors `hasScope` in src/core/api/scopes.ts, including that write
 * implies append implies read within an area. Two copies of one rule is a
 * liability, so be clear about which is which: the server's copy is the
 * control, and this one exists only to decide what to draw. Getting this wrong
 * can hide a control the operator is entitled to, or show one that 403s — it
 * can never grant anything.
 */
function can(required) {
  for (const held of state.scopes) {
    if (held === WILDCARD || held === required) return true;
    const [area, verb] = held.split(":");
    if (verb === "write" && (required === `${area}:read` || required === `${area}:append`)) return true;
    if (verb === "append" && required === `${area}:read`) return true;
  }
  return false;
}

/**
 * Account administration needs the OWNER role on top of the scope, because an
 * api-token is never OWNER however broadly it is scoped (see requireOwner).
 * Checking both here is what keeps the owner-only tabs off the page for a
 * wildcard token that would still fail every request behind them.
 */
const isOwner = () => state.role === "OWNER" && can("users:admin");

// ---------------------------------------------------------------- DOM helpers

const $ = (id) => document.getElementById(id);

/**
 * Minimal element builder. `on*` keys become listeners, `text` becomes
 * textContent, everything else becomes an attribute.
 */
function el(tag, attrs, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = String(value);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const kid of kids.flat(3)) {
    if (kid == null || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

const card = (title, ...kids) => el("div", { class: "card" }, title ? el("h2", { text: title }) : null, ...kids);
const row = (...kids) => el("div", { class: "row" }, ...kids);

function table(headers, rows) {
  if (!rows.length) return el("p", { class: "dim", text: "Nothing here." });
  return el(
    "div",
    { class: "scroll" },
    el(
      "table",
      {},
      el("thead", {}, el("tr", {}, headers.map((h) => el("th", { text: h })))),
      el(
        "tbody",
        {},
        rows.map((cells) =>
          el(
            "tr",
            {},
            cells.map((cell) =>
              cell && cell.nodeType
                ? el("td", {}, cell)
                : Array.isArray(cell)
                  ? el("td", { class: "actions row tight" }, cell)
                  : el("td", { text: cell == null || cell === "" ? "—" : cell }),
            ),
          ),
        ),
      ),
    ),
  );
}

const STATE_TONE = {
  PROCESSED: "ok",
  SUCCEEDED: "ok",
  COMMITTED: "ok",
  DONE: "ok",
  ACTIVE: "ok",
  TRACKED: "ok",
  CREATED: "ok",
  FAILED: "bad",
  DEAD_LETTER: "bad",
  QUARANTINED: "bad",
  REVOKED: "bad",
  CANCELLED: "warn",
  SKIPPED: "warn",
  DRAINED: "warn",
  EXECUTING: "busy",
  INGESTING: "busy",
  RUNNING: "busy",
  LEASED: "busy",
  CREATING: "busy",
  enabled: "ok",
  approved: "ok",
  disabled: "bad",
  pending: "warn",
  OWNER: "busy",
};

const chip = (value) => el("span", { class: `chip ${STATE_TONE[value] || ""}`.trim(), text: value ?? "—" });

function fmtTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
}

/** Compact "how long ago", used for heartbeats where staleness is the signal. */
function ago(value) {
  if (!value) return "never";
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

const truncate = (text, max = 160) =>
  typeof text === "string" && text.length > max ? `${text.slice(0, max)}…` : text;

/**
 * A button that is visibly disabled, and says why, when the principal lacks
 * `scope`.
 *
 * Disabling beats hiding for a destructive action a colleague might expect to
 * find: a greyed-out "Remove" that explains it needs `tracked:write` tells a
 * contributor the operation exists and who to ask, whereas an absent button
 * reads as a missing feature. The tooltip names the scope because that is the
 * only actionable part of the answer.
 */
function gatedButton(scope, attrs) {
  const allowed = can(scope);
  return el("button", {
    ...attrs,
    type: "button",
    disabled: !allowed || attrs.disabled === true,
    title: allowed ? (attrs.title ?? null) : `Needs the "${scope}" scope, which this account does not hold.`,
    onclick: allowed ? attrs.onclick : undefined,
  });
}

/**
 * Hand the browser a generated file. Used for the series-map export and
 * anything else the operator needs to round-trip through a text editor, so
 * "export, edit, paste back" never involves a file in git or a shell on the
 * host.
 */
function download(filename, text, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const link = el("a", { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  // Revoking immediately can cancel the download in some browsers; one turn of
  // the event loop is enough for it to have started.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Prev/next pager for a client-side page of `rows`. */
function pager(total, page, size, onChange) {
  const pages = Math.max(1, Math.ceil(total / size));
  const clamped = Math.min(Math.max(page, 0), pages - 1);
  return row(
    el("button", { type: "button", text: "‹ Prev", disabled: clamped === 0, onclick: () => onChange(clamped - 1) }),
    el("span", { class: "dim", text: `Page ${clamped + 1} of ${pages} · ${total} row(s)` }),
    el("button", {
      type: "button",
      text: "Next ›",
      disabled: clamped >= pages - 1,
      onclick: () => onChange(clamped + 1),
    }),
  );
}

// ------------------------------------------------------------------- feedback

function toast(message, ok = true) {
  const node = el("div", { class: `toast ${ok ? "ok" : "bad"}`, text: message });
  $("toasts").append(node);
  setTimeout(() => node.remove(), 6000);
}

function openModal(title, body) {
  $("modal-title").textContent = title;
  const host = $("modal-body");
  host.replaceChildren(body);
  $("modal").showModal();
}

const closeModal = () => $("modal").close();

// ------------------------------------------------------------------------ api

class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    // The parsed body, for the callers that need more than the first line —
    // the bundle preflight returns a list of reasons under a 422, and showing
    // only `error` would hide all but one of them.
    this.body = body ?? null;
  }
}

/**
 * Every admin call goes through here: same-origin credentials (the session
 * cookie), the CSRF header the server demands on cookie-authenticated writes,
 * and a single place that drops back to the login screen on 401.
 */
async function api(path, opts) {
  const options = opts || {};
  const init = {
    method: options.method || "GET",
    credentials: "same-origin",
    headers: { [CSRF_HEADER]: CSRF_VALUE, accept: "application/json", ...(options.headers || {}) },
  };
  if (options.body !== undefined) {
    if (options.raw) {
      init.body = options.body;
    } else {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
  }

  const res = await fetch(API + path, init);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (res.status === 401 && !options.allow401) {
    showLogin(state.actor ? "Session expired. Sign in again." : "");
    throw new ApiError(401, "not authenticated");
  }
  const message = (data && data.error) || `${res.status} ${res.statusText}`;
  // A missing scope is a configuration answer, not a transient failure: naming
  // the scope is the difference between "it broke" and "your credential needs
  // runs:write". Probes pass `quiet` because a 403 is their expected answer.
  if (res.status === 403 && !options.quiet) {
    const scope = /^missing scope:\s*(\S+)/.exec(message);
    if (scope) toast(`Not permitted — this credential is missing the "${scope[1]}" scope.`, false);
  }
  if (!res.ok) throw new ApiError(res.status, message, data);
  return data;
}

/**
 * Ask the server what this principal is and may do.
 *
 * This replaced probing an owner-only endpoint and reading the 403: that told
 * us one bit, and the page needs the whole scope set to decide what to draw.
 * A CONTRIBUTOR must not be shown a Workers tab that answers 403 on every
 * request, and an operator must not have a button hidden from them because the
 * SPA guessed from a role name.
 *
 * On failure the principal keeps whatever the session payload claimed and no
 * scopes, which renders the smallest possible surface. That is the right way to
 * fail: an operator who sees too few tabs reloads, whereas one who sees too
 * many learns by clicking.
 */
async function loadWhoami() {
  try {
    const me = await api("/whoami", { allow401: true, quiet: true });
    state.scopes = Array.isArray(me.scopes) ? me.scopes : [];
    state.kind = me.kind ?? null;
    if (me.role) state.role = me.role;
  } catch {
    state.scopes = [];
    state.kind = null;
  }
}

/** What each role is for, named on the banner so the limits are not a surprise. */
const ROLE_BLURB = {
  OWNER: "Full control plane, including operator accounts, client tokens and database backups.",
  ADMIN: "Full control plane except operator accounts and client tokens.",
  CONTRIBUTOR:
    "Series-map curation and untracked triage. Adding mappings is allowed; changing or removing " +
    "an existing one needs an operator.",
};

/**
 * Name the current role and its limits, so a contributor understands that the
 * short tab strip is the design rather than a bug — and so an operator can see
 * at a glance which credential they are acting as.
 */
function renderRoleBanner() {
  const banner = $("role-banner");
  const role = state.role;
  if (!role) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  banner.className = role === "CONTRIBUTOR" ? "banner info" : "banner quiet";
  banner.replaceChildren(
    el("strong", { text: `Signed in as ${role.toLowerCase()}` }),
    document.createTextNode(
      `${state.kind === "root" ? " (break-glass admin token)" : ""} — ${ROLE_BLURB[role] ?? ""}`,
    ),
  );
}

/** Wrap a mutating call: toast the outcome, then refresh the current view. */
async function act(label, fn, { refresh = true } = {}) {
  try {
    const result = await fn();
    toast(`${label}: ok`);
    if (refresh) await renderTab();
    return result;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return undefined;
    toast(`${label}: ${err.message}`, false);
    return undefined;
  }
}

const confirmDestructive = (message) => window.confirm(message);

// --------------------------------------------------------------- auth & shell

function showLogin(message) {
  stopRefresh();
  state.actor = null;
  state.role = null;
  state.userId = null;
  state.scopes = [];
  state.kind = null;
  $("app").hidden = true;
  $("role-banner").hidden = true;
  $("whoami").textContent = "";
  $("logout").hidden = true;
  $("pause-pill").hidden = true;
  $("login").hidden = false;
  $("login-error").textContent = message || "";
  $("login-token").value = "";
  $("login-password").value = "";
  $("login-email").focus();
  // Also reached on a mid-session 401, so refresh what the page offers.
  void applyLoginMethods();
}

async function showApp(session) {
  state.actor = session.actor;
  state.role = session.role;
  state.userId = session.userId;
  $("login").hidden = true;
  $("app").hidden = false;
  $("whoami").textContent = session.actor
    ? `${session.actor}${session.role ? ` · ${session.role.toLowerCase()}` : ""}`
    : "";
  $("logout").hidden = false;
  await loadWhoami();
  renderRoleBanner();
  buildTabs();
  startRefresh();
}

/** Render only the methods this deployment actually offers. */
async function applyLoginMethods() {
  try {
    const methods = await api("/session/methods", { allow401: true });
    $("login-discord-wrap").hidden = !methods.discord;
    $("login-signups").hidden = !(methods.discord && methods.signups);
  } catch {
    // A deployment that cannot answer still offers password + token login.
    $("login-discord-wrap").hidden = true;
  }
}

async function submitLogin(event, body, clear) {
  event.preventDefault();
  $("login-error").textContent = "";
  try {
    const res = await api("/session", { method: "POST", body, allow401: true });
    clear();
    await showApp(res);
    await renderTab();
  } catch (err) {
    $("login-error").textContent = err.message;
  }
}

const loginWithPassword = (event) =>
  submitLogin(
    event,
    { email: $("login-email").value.trim(), password: $("login-password").value },
    () => {
      $("login-password").value = "";
    },
  );

const loginWithToken = (event) =>
  submitLogin(
    event,
    { token: $("login-token").value, actor: $("login-actor").value.trim() || undefined },
    () => {
      $("login-token").value = "";
    },
  );

async function logout() {
  try {
    await api("/session", { method: "DELETE", allow401: true });
  } finally {
    showLogin("Signed out.");
  }
}

// ------------------------------------------------------------------ tab router

/**
 * Every tab names the scope its view needs to render at all. A principal that
 * lacks it never sees the tab — a CONTRIBUTOR gets Overview, Extensions and
 * Untracked and nothing else.
 *
 * Hiding is cosmetic and must be read that way: the server checks the same
 * scope on every endpoint behind every tab, and the integration suite asserts
 * the refusals directly rather than trusting this list. What this buys is that
 * an operator is never offered a control that cannot work.
 */
const TABS = [
  ["overview", "Overview", { scope: "stats:read" }],
  ["activity", "Activity", { scope: "runs:read" }],
  ["workers", "Workers", { scope: "workers:read" }],
  ["extensions", "Extensions", { scope: "extensions:read" }],
  ["runs", "Runs", { scope: "runs:read" }],
  ["queues", "Queues", { scope: "runs:read" }],
  ["untracked", "Untracked", { scope: "untracked:read" }],
  ["quarantine", "Quarantine", { scope: "runs:read" }],
  ["audit", "Audit", { scope: "audit:read" }],
  ["system", "System", { scope: "settings:read" }],
  // Account administration and credential minting are the two things an ADMIN
  // cannot do, and they need the OWNER role rather than a scope: a wildcard api
  // token holds users:admin but is never OWNER.
  ["users", "Users", { owner: true }],
  ["tokens", "Tokens", { owner: true }],
];

const tabAllowed = (opts) => {
  if (!opts) return true;
  if (opts.owner) return isOwner();
  return !opts.scope || can(opts.scope);
};

const visibleTabs = () => TABS.filter(([, , opts]) => tabAllowed(opts));

function buildTabs() {
  const visible = visibleTabs();
  // Land on the first tab this principal can actually use rather than assuming
  // Overview: a narrowly-scoped credential may not hold stats:read, and
  // defaulting to a view that 403s is the exact failure this gating removes.
  if (!visible.some(([id]) => id === state.tab)) state.tab = visible.length ? visible[0][0] : null;
  $("tabs").replaceChildren(
    ...visibleTabs().map(([id, label]) =>
      el("button", {
        type: "button",
        role: "tab",
        id: `tab-${id}`,
        "aria-selected": String(id === state.tab),
        text: label,
        onclick: () => selectTab(id),
      }),
    ),
  );
}

async function selectTab(id) {
  state.tab = id;
  for (const [tabId] of visibleTabs()) {
    const button = $(`tab-${tabId}`);
    if (button) button.setAttribute("aria-selected", String(tabId === id));
  }
  await renderTab();
}

const VIEWS = {
  overview: viewOverview,
  activity: viewActivity,
  workers: viewWorkers,
  extensions: viewExtensions,
  runs: viewRuns,
  queues: viewQueues,
  untracked: viewUntracked,
  quarantine: viewQuarantine,
  audit: viewAudit,
  system: viewSystem,
  users: viewUsers,
  tokens: viewTokens,
};

async function renderTab() {
  const view = $("view");
  if (!state.tab) {
    // Reachable for a credential scoped for one machine job (say bundles:write
    // for CI). Say what it holds rather than showing an empty page.
    view.replaceChildren(
      card(
        "Nothing to show",
        el("p", {
          text:
            "This credential holds no scope that the dashboard renders a section for. It can still " +
            "be used against the API directly.",
        }),
        el("p", { class: "dim", text: `Scopes: ${state.scopes.join(", ") || "none"}` }),
      ),
    );
    return;
  }
  try {
    view.replaceChildren(await VIEWS[state.tab]());
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    view.replaceChildren(card("Error", el("p", { class: "error", text: err.message })));
  }
}

function startRefresh() {
  stopRefresh();
  state.timer = setInterval(() => {
    if (state.tab === "overview" && !$("modal").open && !document.hidden) void renderTab();
  }, REFRESH_MS);
}

function stopRefresh() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

// -------------------------------------------------------------------- overview

async function viewOverview() {
  const stats = await api("/stats");
  const pill = $("pause-pill");
  pill.hidden = false;
  pill.textContent = stats.paused ? "paused" : "running";
  pill.className = stats.paused ? "pill warn" : "pill";

  const minutes = el("input", {
    type: "number",
    id: "pause-minutes",
    min: "1",
    max: "1440",
    value: "60",
    "aria-label": "Pause duration in minutes",
  });

  // A contributor sees the pause state — it explains why nothing is moving —
  // but not the levers, which need settings:write.
  const controls = card(
    "Platform",
    stats.paused
      ? el("div", { class: "banner", text: "Scheduling is paused. No new jobs will be leased." })
      : null,
    can("settings:write")
      ? row(
          minutes,
          el("button", {
            type: "button",
            text: "Pause for N minutes",
            onclick: () =>
              act("pause", () =>
                api("/pause", { method: "POST", body: { minutes: Number(minutes.value) || 60 } }),
              ),
          }),
          el("button", {
            type: "button",
            text: "Pause indefinitely",
            onclick: () =>
              confirmDestructive("Pause the platform until explicitly resumed?") &&
              act("pause", () => api("/pause", { method: "POST", body: {} })),
          }),
          el("button", {
            type: "button",
            class: "primary",
            text: "Resume",
            onclick: () => act("resume", () => api("/resume", { method: "POST", body: {} })),
          }),
        )
      : el("p", {
          class: "dim",
          text: `Scheduling is ${stats.paused ? "paused" : "running"}. Pausing and resuming needs the "settings:write" scope.`,
        }),
  );

  const counts = (title, entries) =>
    card(
      title,
      entries.length
        ? el(
            "div",
            { class: "grid" },
            entries.map(([key, value]) =>
              el("div", { class: "stat" }, el("div", { class: "n", text: value }), el("div", { class: "k", text: key })),
            ),
          )
        : el("p", { class: "dim", text: "Nothing queued." }),
    );

  const uploadRows = (stats.uploadTasks || []).map((r) => [r.kind, chip(r.state), String(r.count)]);

  return el(
    "div",
    {},
    controls,
    counts("Jobs by state", Object.entries(stats.jobs || {})),
    counts("Workers by status", Object.entries(stats.workers || {})),
    card("Upload tasks", table(["Kind", "State", "Count"], uploadRows)),
    card(
      "Quarantine",
      el("p", {
        class: stats.quarantined ? "error" : "dim",
        text: `${stats.quarantined} quarantined result submission(s).`,
      }),
    ),
    // The platform's own MangaDex credential is settings state, so it stays off
    // a contributor's Overview entirely rather than degrading to a 403 note.
    can("settings:read") ? await mangadexCard() : null,
  );
}

/** Human-readable countdown; negative means the deadline has already passed. */
function duration(seconds) {
  const abs = Math.abs(Math.round(seconds));
  const parts =
    abs < 60
      ? `${abs}s`
      : abs < 3600
        ? `${Math.floor(abs / 60)}m ${abs % 60}s`
        : abs < 86_400
          ? `${Math.floor(abs / 3600)}h ${Math.floor((abs % 3600) / 60)}m`
          : `${Math.floor(abs / 86_400)}d ${Math.floor((abs % 86_400) / 3600)}h`;
  return seconds < 0 ? `${parts} ago` : `in ${parts}`;
}

/**
 * MangaDex session state. Rendered inside the Overview because "is the upload
 * side authenticated?" belongs next to the queue depths — an expired session is
 * why the upload queue stops draining.
 *
 * A 403 here is expected for a narrowly-scoped credential, so it degrades to a
 * note instead of failing the whole Overview.
 */
async function mangadexCard() {
  let auth;
  try {
    auth = await api("/mangadex/auth", { quiet: true });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) throw err;
    return card(
      "MangaDex session",
      el("p", { class: "dim", text: `Not available: ${err.message}` }),
    );
  }

  const status = !auth.hasAccess
    ? "no saved session"
    : auth.expired
      ? "expired"
      : auth.expiresInSeconds === null
        ? "saved, expiry unknown"
        : "active";

  return card(
    "MangaDex session",
    row(
      chip(status === "active" ? "ACTIVE" : status === "expired" ? "FAILED" : "pending"),
      el("span", {
        class: "dim",
        text:
          auth.expiresInSeconds === null
            ? auth.hasAccess
              ? "Access token present; its expiry could not be read."
              : "The next upload will authenticate from the configured credentials."
            : `Access token expires ${duration(auth.expiresInSeconds)} (${fmtTime(auth.expiresAt)}).`,
      }),
    ),
    el("p", {
      class: "dim",
      text: `Refresh token ${auth.hasRefresh ? "present" : "absent"}. Tokens are never shown here.`,
    }),
    row(
      el("button", {
        type: "button",
        class: "danger",
        text: "Clear saved session",
        onclick: () => {
          if (
            !confirmDestructive(
              "Forget the saved MangaDex session?\n\nThe next upload re-authenticates from the configured " +
                "credentials. In-flight uploads may fail once and retry. This does not revoke anything on " +
                "MangaDex's side.",
            )
          ) {
            return;
          }
          void act("mangadex_auth.clear", () => api("/mangadex/auth/clear", { method: "POST", body: {} }));
        },
      }),
    ),
  );
}

// --------------------------------------------------------------------- workers

async function viewWorkers() {
  const { workers } = await api("/workers");

  const lifecycle = (worker, action, label, danger) =>
    el("button", {
      type: "button",
      class: danger ? "danger" : null,
      text: label,
      onclick: () => {
        if (danger && !confirmDestructive(`Revoke ${worker.name}? Its token stops working immediately.`)) return;
        void act(`worker.${action}`, () => api(`/workers/${worker.id}/${action}`, { method: "POST", body: {} }));
      },
    });

  const rows = workers.map((worker) => [
    el("div", {}, el("div", { text: worker.name }), el("div", { class: "dim", text: worker.id })),
    chip(worker.status),
    worker.trust,
    ago(worker.lastHeartbeatAt),
    worker.agentVersion,
    (worker.extensions || []).join(", ") || "any",
    [
      lifecycle(worker, "drain", "Drain", false),
      lifecycle(worker, "activate", "Activate", false),
      lifecycle(worker, "revoke", "Revoke", true),
    ],
  ]);

  return el(
    "div",
    {},
    card(
      "Fleet",
      row(el("button", { type: "button", class: "primary", text: "Enroll new worker", onclick: enrollDialog })),
    ),
    card(
      null,
      table(["Worker", "Status", "Trust", "Heartbeat", "Agent", "Extensions", ""], rows),
    ),
  );
}

function enrollDialog() {
  const trust = el(
    "select",
    { id: "enroll-trust" },
    el("option", { value: "COMMUNITY", text: "COMMUNITY" }),
    el("option", { value: "TRUSTED", text: "TRUSTED" }),
  );
  const note = el("input", { id: "enroll-note", type: "text", maxlength: "256", placeholder: "who this is for" });
  const ttl = el("input", { id: "enroll-ttl", type: "number", min: "1", max: "720", value: "24" });
  const name = el("input", { id: "enroll-name", type: "text", value: "publoader-worker-1", maxlength: "128" });

  const body = el(
    "div",
    {},
    el("label", { for: "enroll-trust", text: "Trust tier" }),
    trust,
    el("label", { for: "enroll-note", text: "Note" }),
    note,
    el("label", { for: "enroll-ttl", text: "Token TTL (hours)" }),
    ttl,
    el("label", { for: "enroll-name", text: "Worker name (for the snippet)" }),
    name,
    el(
      "div",
      { class: "row" },
      el("button", {
        type: "button",
        class: "primary",
        text: "Mint token",
        onclick: async () => {
          const minted = await act(
            "enroll-token.create",
            () =>
              api("/enroll-tokens", {
                method: "POST",
                body: {
                  trust: trust.value,
                  note: note.value || undefined,
                  ttlHours: Number(ttl.value) || 24,
                },
              }),
            { refresh: false },
          );
          if (minted) showEnrollToken(minted, name.value.trim() || "publoader-worker-1");
        },
      }),
    ),
  );
  openModal("Enroll a worker", body);
}

function showEnrollToken(minted, workerName) {
  const snippet = [
    "# publoader worker — one-time enrolment token",
    `# expires ${fmtTime(minted.expiresAt)}; it enrolls exactly one worker.`,
    "services:",
    "  publoader-worker:",
    "    image: ghcr.io/publoader/worker:latest",
    "    restart: unless-stopped",
    "    environment:",
    `      CORE_URL: ${window.location.origin}`,
    `      ENROLL_TOKEN: ${minted.token}`,
    `      WORKER_NAME: ${workerName}`,
    "    volumes:",
    "      - publoader-worker-state:/var/lib/publoader-worker",
    "volumes:",
    "  publoader-worker-state:",
  ].join("\n");

  const pre = el("pre", { text: snippet });
  openModal(
    "One-time enrolment token",
    el(
      "div",
      {},
      el("p", {
        class: "error",
        text: "Shown once. It is not recoverable — copy it now, and send it over a private channel.",
      }),
      pre,
      row(
        el("button", {
          type: "button",
          class: "primary",
          text: "Copy compose snippet",
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(snippet);
              toast("copied to clipboard");
            } catch {
              toast("clipboard blocked — select the text manually", false);
            }
          },
        }),
        el("button", { type: "button", text: "Done", onclick: closeModal }),
      ),
    ),
  );
}

// ------------------------------------------------------------------ extensions

async function viewExtensions() {
  // Removal mode is settings state, so a contributor never asks for it — the
  // request would 403 and the card is not theirs to see.
  const [{ extensions }, removal] = await Promise.all([
    api("/extensions"),
    can("settings:read") ? api("/removal-mode") : Promise.resolve(null),
  ]);

  const detail = el("div", { id: "ext-detail" });

  const rows = extensions.map((ext) => [
    ext.name,
    ext.version,
    el("code", { text: (ext.sha256 || "").slice(0, 12) }),
    fmtTime(ext.publishedAt),
    chip(ext.disabled ? "disabled" : "enabled"),
    [
      gatedButton("runs:write", { text: "Run", onclick: () => triggerRun(ext.name, "UPDATE") }),
      gatedButton("runs:write", { text: "Force", onclick: () => triggerRun(ext.name, "FORCE") }),
      gatedButton("runs:write", { class: "danger", text: "Clean", onclick: () => triggerRun(ext.name, "CLEAN") }),
      gatedButton("extensions:write", {
        text: ext.disabled ? "Enable" : "Disable",
        onclick: () =>
          act(`extension.${ext.disabled ? "enable" : "disable"}`, () =>
            api(`/extensions/${encodeURIComponent(ext.name)}/${ext.disabled ? "enable" : "disable"}`, {
              method: "POST",
              body: {},
            }),
          ),
      }),
      el("button", {
        type: "button",
        class: "primary",
        // "Configure" undersold it once this became the series-map and activity
        // view as well; a contributor's whole job lives behind this button.
        text: "Open",
        onclick: async () => {
          detail.replaceChildren(el("p", { class: "dim", text: "Loading…" }));
          detail.replaceChildren(await extensionDetail(ext.name));
          detail.scrollIntoView({ behavior: "smooth", block: "start" });
        },
      }),
    ],
  ]);

  return el(
    "div",
    {},
    removal ? removalModeCard(removal) : null,
    can("bundles:write") ? publishCard() : null,
    card("Published bundles", table(["Extension", "Version", "sha256", "Published", "State", ""], rows)),
    detail,
  );
}

function removalModeCard(removal) {
  const modeSelect = el(
    "select",
    { id: "removal-mode", "aria-label": "Chapter removal mode" },
    removal.validModes.map((mode) => el("option", { value: mode, text: mode, selected: mode === removal.mode })),
  );
  return card(
    "Chapter removal mode",
    row(
      el("label", { for: "removal-mode", text: "When a chapter disappears from the source" }),
      modeSelect,
      gatedButton("settings:write", {
        text: "Save",
        onclick: () =>
          act("removal-mode.set", () => api("/removal-mode", { method: "POST", body: { mode: modeSelect.value } })),
      }),
    ),
  );
}

// ------------------------------------------------------- bundle publishing (zip)

/**
 * CRC-32, table-driven. Needed because a zip entry carries its own checksum and
 * the archive is rejected outright without a correct one.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Build a STORED (uncompressed) zip from picked files, in the browser.
 *
 * This is what makes "publish an extension directory" possible without a shell:
 * the directory picker hands us the files, and the publish endpoint wants a zip.
 * Store-only keeps it to one page of code with no dependency — the publish path
 * hashes and stores the archive rather than caring how well it compresses, and
 * AdmZip on the server reads stored entries like any other.
 *
 * Entry names are made relative to the picked directory, which also fixes the
 * single most common publish mistake: zipping the directory itself, so
 * manifest.json ends up one level down and the server cannot find it.
 */
async function zipStored(files) {
  const encoder = new TextEncoder();
  const local = [];
  const central = [];
  let offset = 0;

  const u16 = (value) => [value & 0xff, (value >>> 8) & 0xff];
  const u32 = (value) => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];

  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = new Uint8Array(await file.blob.arrayBuffer());
    const crc = crc32(data);
    // Flag 0x0800 declares the name is UTF-8. Time/date are left at zero: a
    // bundle is identified by its sha256, so a fabricated mtime would only make
    // two byte-identical publishes hash differently.
    const header = [
      ...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0),
      ...u16(0), ...u16(0), ...u32(crc), ...u32(data.length), ...u32(data.length),
      ...u16(name.length), ...u16(0),
    ];
    local.push(new Uint8Array(header), name, data);
    central.push(
      new Uint8Array([
        ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0),
        ...u16(0), ...u16(0), ...u32(crc), ...u32(data.length), ...u32(data.length),
        ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0),
        ...u32(offset),
      ]),
      name,
    );
    offset += header.length + name.length + data.length;
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const eocd = new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0),
    ...u16(files.length), ...u16(files.length),
    ...u32(centralSize), ...u32(offset), ...u16(0),
  ]);
  return new Blob([...local, ...central, eocd], { type: "application/zip" });
}

/** Strip the picked directory's own name so manifest.json lands at the root. */
function relativeEntries(fileList) {
  const files = [...fileList];
  const paths = files.map((file) => file.webkitRelativePath || file.name);
  const root = paths[0]?.includes("/") ? `${paths[0].split("/")[0]}/` : "";
  return files
    .map((file, index) => ({ name: (paths[index] ?? file.name).slice(root.length), blob: file }))
    // Editor droppings and VCS metadata have no business in a published bundle,
    // and node_modules would blow past the 64 MiB body limit.
    .filter(
      (entry) =>
        entry.name &&
        !entry.name.startsWith(".git/") &&
        !entry.name.includes("/node_modules/") &&
        !entry.name.endsWith(".DS_Store") &&
        !entry.name.endsWith(".pyc"),
    );
}

/**
 * Publish a bundle: drop a zip, pick a zip, or pick the extension directory.
 *
 * Publishing runs a preflight first and shows the verdict inline. The reason is
 * not convenience: a publish is a code-execution change on every worker that
 * runs this extension, so an operator should be looking at the parsed manifest
 * — name, version, entrypoint, whether it replaces what is live — before they
 * confirm, not reading a 422 afterwards.
 */
function publishCard() {
  const file = el("input", { type: "file", id: "bundle-file", accept: ".zip,application/zip" });
  const dir = el("input", { type: "file", id: "bundle-dir" });
  // Not settable via the attribute allow-list in `el`, and only meaningful on
  // browsers that implement it; the zip picker next to it is the fallback.
  dir.webkitdirectory = true;
  dir.multiple = true;

  const status = el("div", { id: "bundle-status" });
  let pending = null;

  const setPending = async (blob, label) => {
    pending = { blob, label };
    status.replaceChildren(el("p", { class: "dim", text: `Checking ${label} (${(blob.size / 1024).toFixed(0)} KiB)…` }));
    const buffer = await blob.arrayBuffer();
    let verdict;
    try {
      verdict = await api("/bundles/inspect", {
        method: "POST",
        raw: true,
        body: buffer,
        headers: { "content-type": "application/zip" },
        quiet: true,
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      // The preflight answers 422 with the reasons in the body; ApiError only
      // carries the first line, so re-read it for the full list.
      verdict = err.body ?? { ok: false, errors: [err.message] };
    }
    status.replaceChildren(publishVerdict(verdict, label, () => publishNow(pending)));
  };

  const publishNow = async (chosen) => {
    if (!chosen) return;
    const buffer = await chosen.blob.arrayBuffer();
    const published = await act(
      "bundle.publish",
      () =>
        api("/bundles", {
          method: "POST",
          raw: true,
          body: buffer,
          headers: { "content-type": "application/zip" },
        }),
      { refresh: false },
    );
    if (published) {
      toast(`published ${published.extension}@${published.version}`);
      await renderTab();
    }
  };

  const drop = el("div", {
    class: "dropzone",
    id: "bundle-drop",
    tabindex: "0",
    role: "button",
    "aria-label": "Drop an extension bundle zip here, or press Enter to choose one",
    text: "Drop a bundle .zip here",
    onclick: () => file.click(),
    onkeydown: (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        file.click();
      }
    },
    ondragover: (event) => {
      event.preventDefault();
      drop.classList.add("over");
    },
    ondragleave: () => drop.classList.remove("over"),
    ondrop: (event) => {
      event.preventDefault();
      drop.classList.remove("over");
      const dropped = event.dataTransfer?.files?.[0];
      if (!dropped) return toast("nothing usable was dropped", false);
      if (!/\.zip$/i.test(dropped.name)) {
        // Directory drops arrive as entries rather than files and would need a
        // recursive FileSystemEntry walk; the directory picker below already
        // does that job, so point at it instead of half-supporting the drop.
        return toast("drop a .zip, or use “Choose directory” for an unzipped extension", false);
      }
      void setPending(dropped, dropped.name);
    },
  });

  file.addEventListener("change", () => {
    const chosen = file.files?.[0];
    if (chosen) void setPending(chosen, chosen.name);
  });

  dir.addEventListener("change", async () => {
    const entries = relativeEntries(dir.files ?? []);
    if (!entries.length) return toast("that directory has no files", false);
    if (!entries.some((entry) => entry.name === "manifest.json")) {
      return toast("no manifest.json at the top level of that directory", false);
    }
    status.replaceChildren(el("p", { class: "dim", text: `Zipping ${entries.length} file(s)…` }));
    void setPending(await zipStored(entries), `${entries.length} file(s)`);
  });

  return card(
    "Publish an extension bundle",
    el("p", {
      class: "dim",
      text:
        "Publishing replaces what every worker runs for this extension. The manifest is validated " +
        "before anything is written, and nothing is published until you confirm.",
    }),
    drop,
    row(
      el("label", { for: "bundle-file", class: "inline", text: "or a zip:" }),
      file,
      el("label", { for: "bundle-dir", class: "inline", text: "or a directory:" }),
      dir,
    ),
    status,
  );
}

/** The preflight result: the parsed manifest, or every reason it was refused. */
function publishVerdict(verdict, label, onPublish) {
  if (!verdict.ok) {
    return el(
      "div",
      {},
      el("p", { class: "error", text: `${label} cannot be published:` }),
      el("ul", { class: "errors" }, (verdict.errors || ["unreadable archive"]).map((line) => el("li", { text: line }))),
    );
  }

  const m = verdict.manifest;
  const facts = [
    ["Extension", m.name],
    ["Version", m.version],
    ["Runtime", m.runtime || `inferred from publoader_api ${m.publoaderApi}`],
    ["Entrypoint", m.entrypoint],
    ["Languages", m.languages.join(", ")],
    ["Allowed hosts", m.allowedHosts.join(", ")],
    ["MangaDex group", m.mangadexGroupId],
    ["Minimum worker trust", m.minTrust],
    ["Files in archive", String(verdict.entries)],
    [
      "Currently published",
      verdict.currentlyPublished
        ? `${verdict.currentlyPublished.version} (${verdict.currentlyPublished.sha256.slice(0, 12)}), ${fmtTime(verdict.currentlyPublished.publishedAt)}`
        : "nothing yet",
    ],
  ];

  return el(
    "div",
    {},
    el("p", { class: "ok-text", text: `${label} validates as ${m.name}@${m.version}.` }),
    verdict.replacesSameVersion
      ? el("div", {
          class: "banner",
          text:
            `Version ${m.version} is already published. Publishing replaces its bytes, and jobs already ` +
            "pinned to the old sha256 will not be able to fetch it. Bump the version to keep both.",
        })
      : null,
    table(["Field", "Value"], facts),
    row(
      el("button", { type: "button", class: "primary", text: `Publish ${m.name}@${m.version}`, onclick: onPublish }),
    ),
  );
}

function triggerRun(extension, kind) {
  if (
    kind === "CLEAN" &&
    !confirmDestructive(
      `Start a CLEAN run for ${extension}?\n\nA clean run re-reads the extension's entire back catalogue and can ` +
        "queue deletions for chapters it no longer sees. This is destructive on MangaDex.",
    )
  ) {
    return;
  }
  void act(`run.${kind}`, () => api("/runs", { method: "POST", body: { extension, kind } }), { refresh: false });
}

// -------------------------------------------------------- one extension, in full

async function extensionDetail(name) {
  const encoded = encodeURIComponent(name);
  // Only the tracked map is guaranteed readable for a contributor; schedules and
  // config both sit behind extensions:read, which they do hold, while activity
  // is worth failing softly on because it is the largest query here.
  // `quiet` on the two optional halves: a narrowly-scoped credential gets a
  // hidden card, not a toast complaining about a request it never made itself.
  const [schedules, config, tracked] = await Promise.all([
    api("/schedules", { quiet: true }).catch(() => null),
    api(`/extensions/${encoded}/config`, { quiet: true }).catch(() => null),
    api(`/extensions/${encoded}/tracked`),
  ]);

  const reload = async () => {
    $("ext-detail").replaceChildren(await extensionDetail(name));
  };

  return el(
    "div",
    {},
    el("h2", { text: name }),
    await extensionActivityCard(name),
    schedules ? scheduleCard(name, schedules) : null,
    config ? configCard(name, config) : null,
    trackedCard(name, tracked.tracked, reload),
    bulkCurationCard(name, tracked.tracked, reload),
  );
}

/**
 * Everything this extension has been doing, in one place: its runs, its jobs,
 * the upload tasks its chapters produced and its quarantined submissions.
 *
 * The value is the join. "The scrape succeeds but nothing reaches MangaDex" is
 * invisible in any single list and obvious here, because the runs are green and
 * the upload tasks are red on the same screen.
 */
async function extensionActivityCard(name) {
  let activity;
  try {
    activity = await api(`/extensions/${encodeURIComponent(name)}/activity?limit=10`, { quiet: true });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) throw err;
    return card("Recent activity", el("p", { class: "dim", text: `Not available: ${err.message}` }));
  }

  const counts = [
    ["tracked series", String(activity.tracked)],
    ...Object.entries(activity.untracked || {}).map(([k, v]) => [`untracked ${k}`, String(v)]),
  ];

  const runRows = activity.runs.map((run) => [
    can("runs:read")
      ? el("button", { type: "button", class: "linkish", text: run.kind, onclick: () => openRun(run.id) })
      : run.kind,
    chip(run.state),
    `${run.segmentsTotal}`,
    run.triggeredBy,
    fmtTime(run.createdAt),
    truncate(run.error, 80),
  ]);

  const jobRows = activity.jobs.map((job) => [
    `${job.segmentIndex + 1}/${job.segmentTotal}`,
    chip(job.state),
    `${job.attempt}/${job.maxAttempts}`,
    job.errorClass || "—",
    truncate(job.lastError, 120),
    fmtTime(job.updatedAt),
  ]);

  const taskRows = activity.uploadTasks.map((task) => [
    task.kind,
    chip(task.state),
    el("code", { text: task.dedupeKey }),
    `${task.attempt}`,
    truncate(task.lastError, 120),
    fmtTime(task.updatedAt),
  ]);

  const quarantineRows = activity.quarantined.map((item) => [
    el("code", { text: item.jobId }),
    el("code", { text: (item.workerId || "").slice(0, 8) }),
    truncate(item.rejectReason, 200),
    fmtTime(item.createdAt),
  ]);

  return card(
    "Recent activity",
    activity.bundle
      ? el("p", {
          class: "dim",
          text:
            `Published ${activity.bundle.version} (${activity.bundle.sha256.slice(0, 12)}) ` +
            `${fmtTime(activity.bundle.publishedAt)}` +
            `${activity.bundle.sourceCommit ? ` from commit ${activity.bundle.sourceCommit.slice(0, 12)}` : ""}.`,
        })
      : el("p", { class: "error", text: "No bundle is published for this extension, so it cannot run." }),
    el(
      "div",
      { class: "grid" },
      counts.map(([key, value]) =>
        el("div", { class: "stat" }, el("div", { class: "n", text: value }), el("div", { class: "k", text: key })),
      ),
    ),
    el("h3", { text: "Runs" }),
    table(["Kind", "State", "Segments", "Triggered by", "Created", "Error"], runRows),
    el("h3", { text: "Jobs" }),
    table(["Segment", "State", "Attempts", "Class", "Last error", "Updated"], jobRows),
    el("h3", { text: "Upload tasks" }),
    el("p", {
      class: "dim",
      text: "Matched on the chapter payload's extension name, so tasks queued before that field existed are absent.",
    }),
    table(["Kind", "State", "Dedupe key", "Attempt", "Last error", "Updated"], taskRows),
    el("h3", { text: "Quarantined submissions" }),
    table(["Job", "Worker", "Reject reason", "Received"], quarantineRows),
  );
}

function scheduleCard(name, schedules) {
  const override = (schedules.overrides || {})[name];
  const fallback = (schedules.defaults || {})[name];
  const current = override || fallback || { hour: 3, minute: 0 };

  const hour = el("input", { id: "sched-hour", type: "number", min: "0", max: "23", value: String(current.hour) });
  const minute = el("input", { id: "sched-minute", type: "number", min: "0", max: "59", value: String(current.minute) });
  const day = el(
    "select",
    { id: "sched-day" },
    el("option", { value: "", text: "every day", selected: current.day == null }),
    ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((label, index) =>
      el("option", { value: String(index), text: label, selected: current.day === index }),
    ),
  );

  return card(
    "Schedule (UTC)",
    el("p", {
      class: "dim",
      text: override
        ? "An override is set; it replaces the manifest schedule."
        : fallback
          ? "Showing the manifest default. Saving creates an override."
          : "No manifest schedule; saving creates an override.",
    }),
    row(
      el("label", { for: "sched-hour", text: "Hour" }),
      hour,
      el("label", { for: "sched-minute", text: "Minute" }),
      minute,
      el("label", { for: "sched-day", text: "Day" }),
      day,
      gatedButton("extensions:write", {
        class: "primary",
        text: "Save override",
        onclick: () => {
          const body = { hour: Number(hour.value), minute: Number(minute.value) };
          if (day.value !== "") body.day = Number(day.value);
          void act("schedule.set", () => api(`/schedules/${encodeURIComponent(name)}`, { method: "PUT", body }));
        },
      }),
      gatedButton("extensions:write", {
        text: "Remove override",
        onclick: () =>
          act("schedule.remove", () => api(`/schedules/${encodeURIComponent(name)}`, { method: "DELETE" })),
      }),
    ),
  );
}

function configCard(name, config) {
  const writable = can("extensions:write");
  const editor = el("textarea", {
    id: "config-json",
    spellcheck: "false",
    readonly: !writable,
    "aria-label": "Override options JSON",
  });
  editor.value = JSON.stringify(config.overrideOptions ?? {}, null, 2);
  const status = el("p", { class: "error" });

  const parse = () => {
    try {
      const parsed = JSON.parse(editor.value || "{}");
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        status.textContent = "Override options must be a JSON object.";
        return null;
      }
      status.textContent = "";
      return parsed;
    } catch (err) {
      status.textContent = `Invalid JSON: ${err.message}`;
      return null;
    }
  };

  return card(
    "Override options",
    el("p", {
      class: "dim",
      text: writable
        ? "The database is the source of truth; this replaces the whole document."
        : 'Read-only: editing extension configuration needs the "extensions:write" scope.',
    }),
    editor,
    status,
    row(
      el("button", {
        type: "button",
        text: "Validate & format",
        onclick: () => {
          const parsed = parse();
          if (parsed) {
            editor.value = JSON.stringify(parsed, null, 2);
            toast("valid JSON");
          }
        },
      }),
      gatedButton("extensions:write", {
        class: "primary",
        text: "Save",
        onclick: () => {
          const parsed = parse();
          if (!parsed) return;
          void act(
            "extension_config.set",
            () =>
              api(`/extensions/${encodeURIComponent(name)}/config`, {
                method: "PUT",
                body: { overrideOptions: parsed },
              }),
            { refresh: false },
          );
        },
      }),
    ),
  );
}

// ------------------------------------------------------------- the series map

const TRACKED_PAGE = 50;

/** `externalId,mdMangaId` — the one format the paste box and the export share. */
const mapLine = (item) => `${item.mangaId},${item.mdMangaId}`;

/**
 * The tracked map for one extension: searchable, paged, and exportable.
 *
 * Searching and paging happen in the browser over the whole set rather than
 * per-request. That is a deliberate trade: the rows are tiny, the batch ceiling
 * is 2000 of them, and having every row in hand is what lets Export produce a
 * complete file and lets the bulk editor preview a removal without a round
 * trip.
 */
function trackedCard(name, tracked, reload) {
  const encoded = encodeURIComponent(name);
  const search = el("input", {
    id: "tracked-search",
    type: "search",
    placeholder: "filter by external id, MangaDex id, or source",
    "aria-label": "Filter tracked mappings",
  });
  const body = el("div", {});
  let page = 0;

  const render = () => {
    const needle = search.value.trim().toLowerCase();
    const matches = needle
      ? tracked.filter((item) =>
          [item.mangaId, item.mdMangaId, item.source].some((field) => (field || "").toLowerCase().includes(needle)),
        )
      : tracked;
    const pages = Math.max(1, Math.ceil(matches.length / TRACKED_PAGE));
    page = Math.min(page, pages - 1);
    const slice = matches.slice(page * TRACKED_PAGE, page * TRACKED_PAGE + TRACKED_PAGE);

    const rows = slice.map((item) => [
      item.mangaId,
      el("a", {
        href: `https://mangadex.org/title/${encodeURIComponent(item.mdMangaId)}`,
        target: "_blank",
        rel: "noreferrer noopener",
        text: item.mdMangaId,
      }),
      item.source,
      fmtTime(item.createdAt),
      [
        gatedButton("tracked:write", {
          class: "danger",
          text: "Remove",
          onclick: () => {
            if (!confirmDestructive(`Stop tracking ${item.mangaId}? Its chapters stop being uploaded. This does not touch MangaDex.`)) {
              return;
            }
            void act(
              "tracked_manga.remove",
              async () => {
                await api(`/extensions/${encoded}/tracked/${encodeURIComponent(item.mangaId)}`, { method: "DELETE" });
                await reload();
              },
              { refresh: false },
            );
          },
        }),
      ],
    ]);

    body.replaceChildren(
      table(["External id", "MangaDex id", "Source", "Added", ""], rows),
      matches.length > TRACKED_PAGE
        ? pager(matches.length, page, TRACKED_PAGE, (next) => {
            page = next;
            render();
          })
        : el("p", { class: "dim", text: `${matches.length} of ${tracked.length} mapping(s).` }),
    );
  };

  search.addEventListener("input", () => {
    page = 0;
    render();
  });
  render();

  const mangaId = el("input", { id: "tracked-manga-id", type: "text", placeholder: "external manga id" });
  const mdMangaId = el("input", { id: "tracked-md-id", type: "text", placeholder: "MangaDex UUID" });

  return card(
    "Tracked series",
    row(
      el("label", { for: "tracked-manga-id", text: "External id" }),
      mangaId,
      el("label", { for: "tracked-md-id", text: "MangaDex id" }),
      mdMangaId,
      gatedButton("tracked:append", {
        class: "primary",
        text: "Add mapping",
        onclick: () =>
          act(
            "tracked_manga.set",
            async () => {
              await api(`/extensions/${encoded}/tracked`, {
                method: "PUT",
                body: { mangaId: mangaId.value.trim(), mdMangaId: mdMangaId.value.trim() },
              });
              await reload();
            },
            { refresh: false },
          ),
      }),
    ),
    el("p", {
      class: "dim",
      text: can("tracked:write")
        ? "Adding a mapping that already exists repoints it."
        : 'Adding a new mapping is allowed. Repointing one that already exists needs the "tracked:write" scope, and is refused with the id it is currently mapped to.',
    }),
    row(
      search,
      el("button", {
        type: "button",
        text: "Export map",
        title: "Download every mapping in the same format the bulk editor accepts",
        onclick: () => {
          const text = [
            `# publoader tracked map for ${name}`,
            `# exported ${new Date().toISOString()} — ${tracked.length} mapping(s)`,
            "# externalId,mdMangaId",
            ...tracked.map(mapLine),
            "",
          ].join("\n");
          download(`${name}-tracked-map.csv`, text, "text/csv");
        },
      }),
    ),
    body,
  );
}

/**
 * Bulk curation: paste lines, see exactly what would happen, then apply.
 *
 * The dry run is not optional and not a checkbox. A paste of 200 lines can add,
 * repoint, no-op and fail in the same batch, and repointing a series silently
 * redirects uploads to a different MangaDex title — so the operator confirms
 * against a per-row verdict rather than against their own reading of the paste.
 * "Apply" only exists once a preview has come back.
 */
function bulkCurationCard(name, tracked, reload) {
  const encoded = encodeURIComponent(name);
  const canWrite = can("tracked:write");

  const mode = el(
    "select",
    { id: "bulk-mode", "aria-label": "Bulk operation" },
    el("option", { value: "set", text: "Add or repoint (externalId,mdMangaId per line)" }),
    el("option", { value: "remove", text: "Remove (one external id per line)", disabled: !canWrite }),
  );
  const text = el("textarea", {
    id: "bulk-text",
    spellcheck: "false",
    placeholder: "abc123,3f1e...-uuid\ndef456,7a2b...-uuid\n# comments and a header row are ignored",
    "aria-label": "Mappings to apply",
  });
  const preview = el("div", { id: "bulk-preview" });
  const applyRow = el("div", {});

  const OUTCOME_TONE = {
    added: "ok",
    updated: "warn",
    unchanged: "dim",
    removed: "warn",
    not_found: "warn",
    rejected_needs_write: "bad",
    invalid: "bad",
  };

  const renderSummary = (summary, parseErrors, onApply) => {
    const totals = [
      ["added", summary.added],
      ["repointed", summary.updated],
      ["unchanged", summary.unchanged],
      ["removed", summary.removed],
      ["rejected", summary.failed],
    ];
    const rows = summary.results.map((result) => [
      result.mangaId,
      result.mdMangaId || "—",
      el("span", { class: `chip ${OUTCOME_TONE[result.outcome] || ""}`.trim(), text: result.outcome }),
      result.detail || "",
    ]);

    preview.replaceChildren(
      el(
        "div",
        { class: "grid" },
        totals.map(([key, value]) =>
          el("div", { class: "stat" }, el("div", { class: "n", text: String(value) }), el("div", { class: "k", text: key })),
        ),
      ),
      parseErrors.length
        ? el(
            "div",
            {},
            el("h3", { text: `${parseErrors.length} line(s) could not be read` }),
            table(
              ["Line", "Text", "Why"],
              parseErrors.map((e) => [String(e.line), el("code", { text: e.text }), e.reason]),
            ),
          )
        : null,
      el("h3", { text: "Per-row outcome" }),
      table(["External id", "MangaDex id", "Outcome", "Detail"], rows),
    );

    applyRow.replaceChildren(
      summary.added + summary.updated + summary.removed === 0
        ? el("p", { class: "dim", text: "Nothing would change, so there is nothing to apply." })
        : row(
            el("button", {
              type: "button",
              class: "primary",
              text: `Apply — ${summary.added} added, ${summary.updated} repointed, ${summary.removed} removed`,
              onclick: onApply,
            }),
            el("button", { type: "button", text: "Discard preview", onclick: () => clear() }),
          ),
    );
  };

  const clear = () => {
    preview.replaceChildren();
    applyRow.replaceChildren();
  };

  /**
   * Removals are judged here rather than by a dry run, because the batch
   * endpoint's dry run deliberately ignores `remove`. The judgement is not a
   * guess: the whole current map is in hand, so "exists → removed, absent →
   * not_found" is exactly what the server will decide, and the scope check is
   * the same one `applyBatch` applies.
   */
  const previewRemoval = (ids) => {
    const present = new Set(tracked.map((item) => item.mangaId));
    const seen = new Set();
    const results = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (!canWrite) {
        results.push({ mangaId: id, outcome: "rejected_needs_write", detail: "removing a mapping needs scope tracked:write" });
      } else if (!present.has(id)) {
        results.push({ mangaId: id, outcome: "not_found", detail: "not in this extension's map" });
      } else {
        results.push({
          mangaId: id,
          mdMangaId: tracked.find((item) => item.mangaId === id)?.mdMangaId,
          outcome: "removed",
        });
      }
    }
    const count = (outcome) => results.filter((r) => r.outcome === outcome).length;
    return {
      added: 0,
      updated: 0,
      unchanged: 0,
      removed: count("removed"),
      failed: count("not_found") + count("rejected_needs_write"),
      results,
    };
  };

  const removalIds = () =>
    text.value
      .split(/\r?\n/)
      .map((line) => line.split("#")[0].trim())
      .filter(Boolean);

  const runPreview = async () => {
    clear();
    if (!text.value.trim()) return toast("paste something first", false);

    if (mode.value === "remove") {
      const ids = removalIds();
      renderSummary(previewRemoval(ids), [], async () => {
        const applied = await act(
          "tracked_manga.batch",
          () => api(`/extensions/${encoded}/tracked/batch`, { method: "POST", body: { remove: ids } }),
          { refresh: false },
        );
        if (applied) {
          clear();
          text.value = "";
          await reload();
        }
      });
      return;
    }

    // Not wrapped in `act`: a preview is not an outcome, and "ok" toasted over a
    // table that says three rows were rejected is actively misleading.
    let dry;
    try {
      dry = await api(`/extensions/${encoded}/tracked/batch`, {
        method: "POST",
        body: { text: text.value, dryRun: true },
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      preview.replaceChildren(el("p", { class: "error", text: `Preview failed: ${err.message}` }));
      return;
    }
    renderSummary(dry, dry.parseErrors || [], async () => {
      const applied = await act(
        "tracked_manga.batch",
        () => api(`/extensions/${encoded}/tracked/batch`, { method: "POST", body: { text: text.value } }),
        { refresh: false },
      );
      if (applied) {
        clear();
        text.value = "";
        await reload();
      }
    });
  };

  mode.addEventListener("change", () => {
    clear();
    text.placeholder =
      mode.value === "remove"
        ? "abc123\ndef456\n# one external id per line"
        : "abc123,3f1e...-uuid\ndef456,7a2b...-uuid\n# comments and a header row are ignored";
  });

  return card(
    "Bulk curation",
    el("p", {
      class: "dim",
      text:
        "Paste lines of externalId,mdMangaId — order-insensitive, with # comments and a header row ignored. " +
        "Up to 2000 rows. Nothing is written until you apply a preview.",
    }),
    row(el("label", { for: "bulk-mode", text: "Operation" }), mode),
    text,
    row(
      gatedButton("tracked:append", { class: "primary", text: "Preview changes", onclick: () => void runPreview() }),
      el("button", {
        type: "button",
        text: "Paste from clipboard",
        onclick: async () => {
          try {
            text.value = await navigator.clipboard.readText();
            clear();
          } catch {
            toast("clipboard blocked — paste into the box directly", false);
          }
        },
      }),
    ),
    !canWrite
      ? el("p", {
          class: "dim",
          text:
            'Batch remove and batch repoint need the "tracked:write" scope. Rows that would change an existing ' +
            "mapping are reported as rejected in the preview, with the id they are currently mapped to.",
        })
      : null,
    preview,
    applyRow,
  );
}
// ------------------------------------------------------------------------ runs

async function viewRuns() {
  const [{ runs }, { jobs }] = await Promise.all([api("/runs?limit=25"), api("/dead-letter")]);

  const runRows = runs.map((run) => [
    el("button", { type: "button", text: run.extension, onclick: () => openRun(run.id) }),
    run.kind,
    chip(run.state),
    `${run.segmentsTotal}`,
    run.triggeredBy,
    fmtTime(run.createdAt),
    truncate(run.error, 80),
  ]);

  const deadRows = jobs.map((job) => [
    job.extension,
    chip(job.errorClass || "DEAD_LETTER"),
    `${job.attempt}/${job.maxAttempts}`,
    truncate(job.lastError, 120),
    fmtTime(job.updatedAt),
    [
      el("button", { type: "button", text: "Open run", onclick: () => openRun(job.runId) }),
      el("button", {
        type: "button",
        class: "primary",
        text: "Replay",
        onclick: () => act("job.retry", () => api(`/jobs/${job.id}/retry`, { method: "POST", body: {} })),
      }),
    ],
  ]);

  return el(
    "div",
    {},
    card("Recent runs", table(["Extension", "Kind", "State", "Segments", "Triggered by", "Created", "Error"], runRows)),
    card("Dead letter", table(["Extension", "Class", "Attempts", "Last error", "Updated", ""], deadRows)),
  );
}

async function openRun(runId) {
  let payload;
  try {
    payload = await api(`/runs/${runId}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    return toast(err.message, false);
  }
  const run = payload.run;

  const jobRows = (run.jobs || []).map((job) => [
    `${job.segmentIndex + 1}/${job.segmentTotal}`,
    chip(job.state),
    `${job.attempt}/${job.maxAttempts}`,
    job.leaseWorkerId ? el("code", { text: job.leaseWorkerId.slice(0, 8) }) : "—",
    fmtTime(job.leaseExpiresAt),
    truncate(job.lastError, 200),
    [
      el("button", {
        type: "button",
        text: "Cancel",
        onclick: () =>
          act("job.cancel", async () => {
            await api(`/jobs/${job.id}/cancel`, { method: "POST", body: {} });
            await openRun(runId);
          }, { refresh: false }),
      }),
      el("button", {
        type: "button",
        text: "Retry",
        onclick: () =>
          act("job.retry", async () => {
            await api(`/jobs/${job.id}/retry`, { method: "POST", body: {} });
            await openRun(runId);
          }, { refresh: false }),
      }),
    ],
  ]);

  const meta = [
    ["Run", run.id],
    ["Extension", `${run.extension} @ ${run.extensionVersion}`],
    ["Bundle", run.bundleSha256],
    ["Kind", run.kind],
    ["Triggered by", run.triggeredBy || "—"],
    ["Created", fmtTime(run.createdAt)],
    ["Started", fmtTime(run.startedAt)],
    ["Completed", fmtTime(run.completedAt)],
    ["Error", run.error || "—"],
  ];

  openModal(
    `Run · ${run.extension}`,
    el(
      "div",
      {},
      row(chip(run.state)),
      table(["Field", "Value"], meta),
      el("h2", { text: "Jobs" }),
      table(["Segment", "State", "Attempts", "Lease holder", "Lease expires", "Last error", ""], jobRows),
    ),
  );
}

// ---------------------------------------------------------------------- queues

const UPLOAD_TASK_KINDS = ["UPLOAD", "EDIT", "DELETE", "UNAVAILABLE"];
const UPLOAD_TASK_STATES = ["PENDING", "LEASED", "DONE", "FAILED", "DEAD_LETTER"];

/**
 * The MangaDex upload queues — the replacement for the legacy `queue_peek` and
 * `queue_clear` IPC commands, and for `restart_workers`: nothing here restarts a
 * process, because every unit of work is a durable row that can be requeued.
 */
async function viewQueues() {
  const kind = state.queueKind || "";
  const taskState = state.queueState || "";
  const query = new URLSearchParams({ limit: "200" });
  if (kind) query.set("kind", kind);
  if (taskState) query.set("state", taskState);
  const { tasks, counts } = await api(`/upload-tasks?${query}`);

  const filter = (id, label, values, current, key) =>
    el(
      "span",
      { class: "row tight" },
      el("label", { for: id, text: label }),
      el(
        "select",
        {
          id,
          onchange: (event) => {
            state[key] = event.target.value;
            void renderTab();
          },
        },
        el("option", { value: "", text: "all", selected: current === "" }),
        values.map((value) => el("option", { value, text: value, selected: value === current })),
      ),
    );

  const summary = card(
    "Depth by kind and state",
    counts.length
      ? el(
          "div",
          { class: "grid" },
          counts
            .slice()
            .sort((a, b) => a.kind.localeCompare(b.kind) || a.state.localeCompare(b.state))
            .map((entry) =>
              el(
                "div",
                { class: "stat" },
                el("div", { class: "n", text: String(entry.count) }),
                el("div", { class: "k" }, `${entry.kind} · `, chip(entry.state)),
              ),
            ),
        )
      : el("p", { class: "dim", text: "No upload tasks have ever been queued." }),
    row(
      filter("queue-kind", "Kind", UPLOAD_TASK_KINDS, kind, "queueKind"),
      filter("queue-state", "State", UPLOAD_TASK_STATES, taskState, "queueState"),
      el("button", {
        type: "button",
        text: "Requeue stale leases",
        onclick: () =>
          act("upload_task.requeue_stale", async () => {
            const res = await api("/upload-tasks/requeue-stale", { method: "POST", body: {} });
            toast(`${res.requeued} stale lease(s) requeued`);
            return res;
          }),
      }),
    ),
    el("p", {
      class: "dim",
      text:
        "Requeueing stale leases only touches tasks whose lease has already expired — a task a live uploader " +
        "still holds is left alone.",
    }),
  );

  const rows = tasks.map((task) => {
    const retryable = task.state === "FAILED" || task.state === "DEAD_LETTER";
    const cancellable = task.state === "PENDING" || retryable;
    return [
      task.kind,
      chip(task.state),
      el("code", { text: task.dedupeKey }),
      `${task.attempt}/${task.maxAttempts}`,
      fmtTime(task.notBefore),
      truncate(task.lastError, 160),
      [
        el("button", {
          type: "button",
          class: retryable ? "primary" : null,
          text: "Retry",
          disabled: !retryable,
          title: retryable ? "Requeue now with a fresh attempt budget" : `${task.state} tasks cannot be retried`,
          onclick: () =>
            act("upload_task.retry", () => api(`/upload-tasks/${task.id}/retry`, { method: "POST", body: {} })),
        }),
        el("button", {
          type: "button",
          class: "danger",
          text: "Cancel",
          disabled: !cancellable,
          title:
            task.state === "LEASED"
              ? "An uploader holds this task; requeue stale leases first"
              : cancellable
                ? "Drop this task without sending it to MangaDex"
                : `${task.state} tasks cannot be cancelled`,
          onclick: () => {
            if (
              !confirmDestructive(
                `Cancel this ${task.kind} task?\n\n${task.dedupeKey}\n\nIt will never be sent to MangaDex. ` +
                  "This cannot be undone from here.",
              )
            ) {
              return;
            }
            void act("upload_task.cancel", () =>
              api(`/upload-tasks/${task.id}/cancel`, { method: "POST", body: {} }),
            );
          },
        }),
      ],
    ];
  });

  return el(
    "div",
    {},
    summary,
    card(
      null,
      table(["Kind", "State", "Dedupe key", "Attempts", "Not before", "Last error", ""], rows),
    ),
  );
}

// -------------------------------------------------------------------- activity

const SEVERITY_TONE = { error: "bad", warn: "warn", info: "" };
const ACTIVITY_WINDOWS = [
  [1, "last hour"],
  [6, "last 6 hours"],
  [24, "last 24 hours"],
  [72, "last 3 days"],
  [168, "last week"],
  [720, "last 30 days"],
];

/**
 * Every application-level event the platform recorded, newest first: runs, jobs
 * (including the last error of a job that is still retrying), upload tasks,
 * quarantined submissions, and the audit trail.
 *
 * This is the answer to "what has been happening?" that used to require
 * `docker logs`, and it is worth being precise about what it does and does not
 * replace. Everything here is a durable row, which is why it can be filtered,
 * linked to, and read months later. Process stdout is NOT here — a stack trace
 * from a crash loop, a prisma connection warning — because nothing writes it to
 * the database. That still lives in `docker logs` on the host.
 */
async function viewActivity() {
  const severity = state.activitySeverity || "all";
  const hours = state.activityHours || 72;
  const needle = state.activityQuery || "";
  const limit = state.activityLimit || 100;

  const query = new URLSearchParams({ severity, hours: String(hours), limit: String(limit) });
  if (needle) query.set("q", needle);
  if (state.activityExtension) query.set("extension", state.activityExtension);
  const feed = await api(`/activity?${query}`);

  const picker = (id, label, options, current, key) =>
    el(
      "span",
      { class: "row tight" },
      el("label", { for: id, class: "inline", text: label }),
      el(
        "select",
        {
          id,
          onchange: (event) => {
            state[key] = event.target.value === "" ? "" : event.target.value;
            void renderTab();
          },
        },
        options.map(([value, text]) =>
          el("option", { value: String(value), text, selected: String(value) === String(current) }),
        ),
      ),
    );

  const search = el("input", {
    id: "activity-q",
    type: "search",
    value: needle,
    placeholder: "text in the subject or message",
    "aria-label": "Filter activity by text",
  });
  // Enter rather than every keystroke: each search is a server round trip over
  // five tables.
  search.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      state.activityQuery = search.value.trim();
      void renderTab();
    }
  });

  const controls = card(
    "Activity",
    el("p", {
      class: "dim",
      text:
        "Runs, jobs, upload tasks, quarantined submissions and audit events in one timeline. Application " +
        "events only — container stdout is not captured here and is still read with docker logs on the host.",
    }),
    row(
      picker(
        "activity-severity",
        "Severity",
        [
          ["all", "everything"],
          ["error", "errors only"],
          ["warn", "warnings"],
          ["info", "informational"],
        ],
        severity,
        "activitySeverity",
      ),
      picker("activity-hours", "Window", ACTIVITY_WINDOWS, hours, "activityHours"),
      picker(
        "activity-limit",
        "Rows",
        [25, 50, 100, 250, 500].map((n) => [n, String(n)]),
        limit,
        "activityLimit",
      ),
      search,
      el("button", {
        type: "button",
        text: "Search",
        onclick: () => {
          state.activityQuery = search.value.trim();
          void renderTab();
        },
      }),
      needle || state.activityExtension
        ? el("button", {
            type: "button",
            text: "Clear filters",
            onclick: () => {
              state.activityQuery = "";
              state.activityExtension = "";
              void renderTab();
            },
          })
        : null,
    ),
    state.activityExtension
      ? el("p", { class: "dim", text: `Filtered to extension ${state.activityExtension}.` })
      : null,
    (feed.omittedSources || []).length
      ? el("div", {
          class: "banner",
          text: `Audit events are not shown: ${feed.omittedSources.map((o) => o.reason).join("; ")}.`,
        })
      : null,
  );

  const rows = feed.activity.map((entry) => [
    el(
      "div",
      {},
      el("div", { text: fmtTime(entry.at) }),
      el("div", { class: "dim", text: ago(entry.at) }),
    ),
    el("span", { class: `chip ${SEVERITY_TONE[entry.severity]}`.trim(), text: entry.severity }),
    el(
      "div",
      {},
      el("div", { text: entry.subject }),
      el("div", { class: "dim", text: entry.kind }),
    ),
    truncate(entry.message, 300) || "—",
    activityActions(entry),
  ]);

  return el("div", {}, controls, card(null, table(["When", "Severity", "Subject", "Message", ""], rows)));
}

/**
 * Per-row actions: open the thing the row is about, and copy a link that lands
 * somebody else on it.
 *
 * The permalink is a fragment rather than a path because the dashboard is a
 * single page served from one route — and a fragment is never sent to the
 * server, so pasting one into chat cannot leak an id into an access log.
 */
function activityActions(entry) {
  // A job's own id opens nothing actionable; its run shows every sibling
  // segment and the retry buttons, so that is what the link points at.
  const target =
    entry.source === "job" && entry.runId ? { type: "run", id: entry.runId } : { type: entry.source, id: entry.id };
  const hash = `#${target.type}/${target.id}`;

  return [
    OPENERS[target.type]
      ? el("button", { type: "button", text: "Open", onclick: () => void openPermalink(hash) })
      : null,
    el("button", {
      type: "button",
      text: "Copy link",
      title: "A link that opens this row for anyone who can sign in",
      onclick: async () => {
        const url = `${window.location.origin}${window.location.pathname}${hash}`;
        try {
          await navigator.clipboard.writeText(url);
          toast("link copied");
        } catch {
          // Falling back to the address bar still gives them something to copy.
          window.location.hash = hash;
          toast("clipboard blocked — the link is in the address bar", false);
        }
      },
    }),
  ].filter(Boolean);
}

/**
 * What a permalink of each type opens. Keyed by the Activity feed's `source`
 * values so a new source needs one entry here and nothing else.
 */
const OPENERS = {
  run: { tab: "runs", open: (id) => openRun(id) },
  // No per-task detail view exists, so land on the queue and name the row that
  // was meant rather than pretending to scroll to it.
  "upload-task": { tab: "queues", open: (id) => toast(`upload task ${id}`) },
  submission: { tab: "quarantine" },
  // The audit search is the detail view: filtering to the event's own id is
  // what actually surfaces one row out of thousands.
  audit: {
    tab: "audit",
    before: (id) => {
      state.auditQuery = id;
      state.auditOffset = 0;
    },
  },
};

/**
 * Handle `#<type>/<id>`, from a pasted permalink or the back button.
 *
 * Returns whether it handled the hash, so boot can tell "the link decided the
 * view" from "render the default tab". A link into a tab this principal cannot
 * see is refused here rather than selected and then answered with a 403 — that
 * is the whole point of gating the tabs.
 */
async function openPermalink(hash) {
  const match = /^#([a-z-]+)\/([\w:-]+)$/.exec(hash || window.location.hash);
  if (!match) return false;
  const [, type, id] = match;

  // A tab-only link (`#tab/queues`) is the other thing people paste.
  const target = type === "tab" ? { tab: id } : OPENERS[type];
  if (!target) return false;
  if (!visibleTabs().some(([tabId]) => tabId === target.tab)) {
    toast(`That link points at ${target.tab}, which this account cannot open.`, false);
    return false;
  }

  target.before?.(id);
  await selectTab(target.tab);
  await target.open?.(id);
  return true;
}
// ------------------------------------------------------------------- untracked

const UNTRACKED_STATES = ["NEW", "CREATING", "CREATED", "TRACKED", "FAILED", "SKIPPED"];

async function viewUntracked() {
  const selected = state.untrackedState || "NEW";
  const { untracked } = await api(`/untracked?state=${selected}&limit=200`);

  const filter = el(
    "select",
    {
      id: "untracked-state",
      "aria-label": "Untracked state filter",
      onchange: (event) => {
        state.untrackedState = event.target.value;
        void renderTab();
      },
    },
    UNTRACKED_STATES.map((value) => el("option", { value, text: value, selected: value === selected })),
  );

  const rows = untracked.map((item) => [
    el(
      "div",
      {},
      el("div", { text: item.mangaName }),
      el("a", { href: item.mangaUrl, target: "_blank", rel: "noreferrer noopener", class: "dim", text: item.mangaUrl }),
    ),
    item.extension,
    item.mangaLanguage,
    chip(item.state),
    `${item.attempts}`,
    item.mdMangaId
      ? el("a", {
          href: `https://mangadex.org/title/${encodeURIComponent(item.mdMangaId)}`,
          target: "_blank",
          rel: "noreferrer noopener",
          text: "on MangaDex",
        })
      : truncate(item.lastError, 100),
    [
      el("button", {
        type: "button",
        class: "primary",
        text: "Approve",
        onclick: () => {
          if (
            !confirmDestructive(
              `Create a MangaDex title for "${item.mangaName}"?\n\nThis publishes a real title and cannot be undone from here.`,
            )
          ) {
            return;
          }
          void act("untracked.approve", async () => {
            const res = await api(`/untracked/${item.id}/approve`, { method: "POST", body: {} });
            if (res && res.mdMangaId) {
              toast(`created https://mangadex.org/title/${res.mdMangaId}`);
            }
            return res;
          });
        },
      }),
      el("button", {
        type: "button",
        text: "Skip",
        onclick: () => act("untracked.skip", () => api(`/untracked/${item.id}/skip`, { method: "POST", body: {} })),
      }),
    ],
  ]);

  return el(
    "div",
    {},
    card("Filter", row(el("label", { for: "untracked-state", text: "State" }), filter)),
    card(null, table(["Series", "Extension", "Lang", "State", "Attempts", "Result", ""], rows)),
  );
}

// ------------------------------------------------------------------ quarantine

async function viewQuarantine() {
  const { quarantined } = await api("/quarantine");
  const rows = quarantined.map((item) => [
    el("code", { text: item.jobId }),
    el("code", { text: (item.workerId || "").slice(0, 8) }),
    truncate(item.rejectReason, 240),
    fmtTime(item.createdAt),
  ]);
  return card(
    "Quarantined result submissions",
    el("p", {
      class: "dim",
      text: "Envelopes rejected by schema or policy validation. Repeat offenders from one worker are the signal to drain it.",
    }),
    table(["Job", "Worker", "Reject reason", "Received"], rows),
  );
}

// ----------------------------------------------------------------------- audit

const AUDIT_PAGE = 100;

/**
 * The audit trail, searchable.
 *
 * Paging back through a fixed number of rows only answers "what happened
 * recently". The questions that actually come up are retrospective — "who
 * changed the removal mode?", "when did this series get repointed, and by
 * whom?" — and they need a search that reaches into the detail JSON, which is
 * where the arguments of every audited action are recorded and the only place
 * they exist.
 */
async function viewAudit() {
  const needle = state.auditQuery || "";
  const actorFilter = state.auditActor || "";
  const actionFilter = state.auditAction || "";
  const offset = state.auditOffset || 0;

  const query = new URLSearchParams({ limit: String(AUDIT_PAGE), offset: String(offset) });
  if (needle) query.set("q", needle);
  if (actorFilter) query.set("actor", actorFilter);
  if (actionFilter) query.set("action", actionFilter);
  const result = await api(`/audit/search?${query}`);

  const search = el("input", {
    id: "audit-q",
    type: "search",
    value: needle,
    placeholder: "actor, action, subject, or anything in the detail",
    "aria-label": "Search the audit log",
  });
  const actorBox = el("input", { id: "audit-actor", type: "search", value: actorFilter, placeholder: "actor" });
  const actionBox = el("input", { id: "audit-action", type: "search", value: actionFilter, placeholder: "action" });

  const apply = () => {
    state.auditQuery = search.value.trim();
    state.auditActor = actorBox.value.trim();
    state.auditAction = actionBox.value.trim();
    state.auditOffset = 0;
    void renderTab();
  };
  for (const box of [search, actorBox, actionBox]) {
    box.addEventListener("keydown", (event) => {
      if (event.key === "Enter") apply();
    });
  }

  const filters = card(
    "Search",
    row(
      el("label", { for: "audit-q", class: "inline", text: "Anything" }),
      search,
      el("label", { for: "audit-actor", class: "inline", text: "Actor" }),
      actorBox,
      el("label", { for: "audit-action", class: "inline", text: "Action" }),
      actionBox,
      el("button", { type: "button", class: "primary", text: "Search", onclick: apply }),
      needle || actorFilter || actionFilter
        ? el("button", {
            type: "button",
            text: "Clear",
            onclick: () => {
              state.auditQuery = "";
              state.auditActor = "";
              state.auditAction = "";
              state.auditOffset = 0;
              void renderTab();
            },
          })
        : null,
      el("button", {
        type: "button",
        text: "Export results",
        title: "Download the matching events as JSON",
        onclick: () =>
          download(
            `publoader-audit-${new Date().toISOString().slice(0, 10)}.json`,
            JSON.stringify(result.events, null, 2),
            "application/json",
          ),
      }),
    ),
    el("p", {
      class: "dim",
      text: `${result.total} matching event(s). Search is a case-insensitive substring, so partial ids and partial action names both work.`,
    }),
  );

  const rows = result.events.map((event) => [
    fmtTime(event.createdAt),
    event.actor,
    // Clicking an action name is the fastest way to ask "what else did this?".
    el("button", {
      type: "button",
      class: "linkish",
      text: event.action,
      title: `Filter to ${event.action}`,
      onclick: () => {
        state.auditAction = event.action;
        state.auditOffset = 0;
        void renderTab();
      },
    }),
    event.subject,
    event.detail ? truncate(JSON.stringify(event.detail), 200) : "—",
  ]);

  return el(
    "div",
    {},
    filters,
    card(
      null,
      table(["When", "Actor", "Action", "Subject", "Detail"], rows),
      result.total > AUDIT_PAGE
        ? pager(result.total, Math.floor(offset / AUDIT_PAGE), AUDIT_PAGE, (page) => {
            state.auditOffset = page * AUDIT_PAGE;
            void renderTab();
          })
        : null,
    ),
  );
}

// ---------------------------------------------------------------------- system

/**
 * The two things that used to need a shell on the host: is the database schema
 * the one this build expects, and can I take a backup right now.
 *
 * Both are read as "should I be worried?", so both lead with a verdict rather
 * than with a table of names.
 */
async function viewSystem() {
  const schema = await api("/schema");

  const verdict = !schema.historyAvailable
    ? { tone: "warn", text: "This database has no prisma migration history." }
    : schema.failed?.length
      ? { tone: "bad", text: `${schema.failed.length} migration(s) failed or were rolled back.` }
      : schema.current === null
        ? { tone: "warn", text: "Pending migrations cannot be detected in this build." }
        : schema.current
          ? { tone: "ok", text: "The schema is up to date." }
          : { tone: "bad", text: `${schema.pending.length} migration(s) have not been applied.` };

  const appliedRows = (schema.applied || []).map((m) => [
    m.name,
    el("span", { class: `chip ${m.failed ? "bad" : "ok"}`, text: m.failed ? "failed" : "applied" }),
    fmtTime(m.appliedAt),
    m.rolledBackAt ? `rolled back ${fmtTime(m.rolledBackAt)}` : "—",
  ]);

  const schemaCard = card(
    "Schema & migrations",
    el("p", { class: verdict.tone === "ok" ? "ok-text" : "error", text: verdict.text }),
    schema.note ? el("p", { class: "dim", text: schema.note }) : null,
    (schema.pending || []).length
      ? el(
          "div",
          {},
          el("div", {
            class: "banner",
            text:
              "Migrations are applied by the one-shot `migrate` service at deploy time, not from here — " +
              "running DDL from the API process is deliberately impossible. See docs/operations.md → Upgrade the core.",
          }),
          table(["Not yet applied"], schema.pending.map((name) => [name])),
        )
      : null,
    el("h3", { text: "History" }),
    table(["Migration", "State", "Applied", "Note"], appliedRows),
  );

  // The dump contains every password hash and the saved MangaDex session, so the
  // link only exists for a principal the server will actually serve it to.
  const backupCard = isOwner()
    ? card(
        "Database backup",
        el("p", {
          class: "dim",
          text:
            "Streams a pg_dump of the whole database in custom format (-Fc), the same shape docs/operations.md " +
            "documents — so a dump taken here and one taken on the host restore identically with pg_restore.",
        }),
        el("div", {
          class: "banner",
          text:
            "The download contains operator password hashes, client token hashes and the saved MangaDex session. " +
            "Treat the file as a credential: encrypt it at rest and keep it off shared storage.",
        }),
        row(
          // A plain link, not fetch(): the browser streams a multi-GB response
          // to disk, whereas fetch would buffer it in the tab first.
          el("a", {
            class: "button-link inline",
            href: `${API}/backup`,
            download: "",
            text: "Download backup",
          }),
        ),
        el("p", {
          class: "dim",
          text:
            "Large databases take a while and the browser shows no progress until bytes arrive. If it answers " +
            "503, this container has no postgres client tools and the backup has to be taken on the host.",
        }),
      )
    : null;

  return el("div", {}, schemaCard, backupCard);
}
// ----------------------------------------------------------------------- users

async function viewUsers() {
  const [{ users }, { sessions }, signups] = await Promise.all([
    api("/users"),
    api("/sessions"),
    api("/settings/signups"),
  ]);

  const reload = async () => {
    $("view").replaceChildren(await viewUsers());
  };

  // -- signup gate --
  const toggle = el("input", {
    type: "checkbox",
    id: "signups-enabled",
    checked: signups.enabled,
    onchange: (event) =>
      act(
        "settings.signups",
        () => api("/settings/signups", { method: "POST", body: { enabled: event.target.checked } }),
        { refresh: false },
      ).then(reload),
  });

  const gate = card(
    "Self-signup",
    el("div", { class: "row" }, toggle, el("label", { for: "signups-enabled", text: "Allow new Discord logins to create accounts" })),
    el("p", {
      class: "dim",
      text: "New accounts always land unapproved and with the ADMIN role; somebody has to approve them here before they can sign in.",
    }),
  );

  // -- invite --
  const inviteEmail = el("input", { id: "invite-email", type: "email", placeholder: "them@example.com" });
  const inviteRole = el(
    "select",
    { id: "invite-role" },
    ROLES.map(([value, label]) => el("option", { value, text: label, selected: value === "ADMIN" })),
  );

  const invite = card(
    "Invite an operator",
    el("p", {
      class: "dim",
      text: "Creates an approved account with no credentials. They get in by linking Discord with that email, or by you setting a password below.",
    }),
    el("p", {
      class: "dim",
      text:
        "CONTRIBUTOR is the role to hand someone outside the operator group: they can add series mappings and " +
        "triage untracked series, and cannot reach runs, workers, credentials or settings. An ADMIN can publish " +
        "bundles, which is code execution on every worker.",
    }),
    row(
      el("label", { for: "invite-email", text: "Email" }),
      inviteEmail,
      el("label", { for: "invite-role", text: "Role" }),
      inviteRole,
      el("button", {
        type: "button",
        class: "primary",
        text: "Invite",
        onclick: () =>
          act(
            "admin_user.invite",
            () =>
              api("/users", {
                method: "POST",
                body: { email: inviteEmail.value.trim(), role: inviteRole.value },
              }),
            { refresh: false },
          ).then(reload),
      }),
    ),
  );

  // -- accounts --
  const userRows = users.map((user) => [
    el(
      "div",
      {},
      el("div", { text: user.email }),
      user.discordUsername ? el("div", { class: "dim", text: `discord: ${user.discordUsername}` }) : null,
    ),
    chip(user.role),
    chip(user.approved ? "approved" : "pending"),
    user.hasPassword ? "password" : user.discordId ? "discord only" : "no credentials",
    user.lastLoginAt ? ago(user.lastLoginAt) : "never",
    [
      !user.approved
        ? el("button", {
            type: "button",
            class: "primary",
            text: "Approve",
            onclick: () =>
              act("admin_user.approve", () => api(`/users/${user.id}/approve`, { method: "POST", body: {} }), {
                refresh: false,
              }).then(reload),
          })
        : null,
      // A select rather than a toggle: with three roles there is no "the other
      // one", and a button that guessed would be the wrong kind of convenient
      // for an action that grants control-plane authority.
      roleSelect(user, reload),
      el("button", { type: "button", text: "Set password", onclick: () => passwordDialog(user, reload) }),
      el("button", {
        type: "button",
        class: "danger",
        text: "Delete",
        onclick: () => {
          if (!confirmDestructive(`Delete ${user.email}? Their sessions are revoked immediately.`)) return;
          void act("admin_user.delete", () => api(`/users/${user.id}`, { method: "DELETE" }), {
            refresh: false,
          }).then(reload);
        },
      }),
    ].filter(Boolean),
  ]);

  // -- live sessions --
  const sessionRows = sessions.map((session) => [
    session.actor,
    session.email,
    chip(session.role),
    fmtTime(session.createdAt),
    fmtTime(session.expiresAt),
    [
      el("button", {
        type: "button",
        class: "danger",
        text: "Revoke",
        onclick: () => {
          if (!confirmDestructive(`Sign ${session.actor} out of this session immediately?`)) return;
          void act("admin_session.revoke", () => api(`/sessions/${session.id}`, { method: "DELETE" }), {
            refresh: false,
          }).then(reload);
        },
      }),
    ],
  ]);

  return el(
    "div",
    {},
    gate,
    invite,
    card("Accounts", table(["Account", "Role", "State", "Credentials", "Last login", ""], userRows)),
    card(
      "Live sessions",
      el("p", { class: "dim", text: "Revoking takes effect on the session's next request." }),
      table(["Actor", "Account", "Role", "Signed in", "Expires", ""], sessionRows),
    ),
  );
}

/** Assignable roles, most privileged first. Mirrors ASSIGNABLE_ROLES in routes/users.ts. */
const ROLES = [
  ["OWNER", "OWNER — full control, including accounts and backups"],
  ["ADMIN", "ADMIN — full control plane, no account administration"],
  ["CONTRIBUTOR", "CONTRIBUTOR — series map and untracked triage only"],
];

/**
 * Change one account's role. Confirms on the way up (granting authority) and on
 * the way down (taking it away mid-session), because both surprise somebody.
 */
function roleSelect(user, reload) {
  const select = el(
    "select",
    {
      "aria-label": `Role for ${user.email}`,
      onchange: (event) => {
        const role = event.target.value;
        if (role === user.role) return;
        const message =
          role === "OWNER"
            ? `Make ${user.email} an OWNER? They will be able to manage every account, mint client tokens, and download database backups.`
            : `Change ${user.email} to ${role}? Their existing sessions keep working with the new, narrower authority from their next request.`;
        if (!confirmDestructive(message)) {
          // Snap back so the control never shows a role that was not applied.
          event.target.value = user.role;
          return;
        }
        void act("admin_user.role", () => api(`/users/${user.id}/role`, { method: "POST", body: { role } }), {
          refresh: false,
        }).then(reload);
      },
    },
    ROLES.map(([value]) => el("option", { value, text: value, selected: value === user.role })),
  );
  return select;
}

function passwordDialog(user, reload) {
  const password = el("input", { id: "new-password", type: "password", minlength: "12", autocomplete: "new-password" });
  const status = el("p", { class: "error" });

  openModal(
    `Set password · ${user.email}`,
    el(
      "div",
      {},
      el("p", { class: "dim", text: "Minimum 12 characters. Any existing password is replaced." }),
      el("label", { for: "new-password", text: "New password" }),
      password,
      status,
      row(
        el("button", {
          type: "button",
          class: "primary",
          text: "Save",
          onclick: async () => {
            if (password.value.length < 12) {
              status.textContent = "Password must be at least 12 characters.";
              return;
            }
            const ok = await act(
              "admin_user.password",
              () => api(`/users/${user.id}/password`, { method: "POST", body: { password: password.value } }),
              { refresh: false },
            );
            password.value = "";
            if (ok) {
              closeModal();
              await reload();
            }
          },
        }),
        el("button", { type: "button", text: "Cancel", onclick: closeModal }),
      ),
    ),
  );
}

// ---------------------------------------------------------------------- tokens

/**
 * Scoped per-client credentials (`pa_…`). OWNER-only, because minting a token
 * can grant any scope — the server enforces that on every endpoint here, so a
 * hidden tab is a convenience, not the control.
 *
 * The secret is shown exactly once, in a modal, and there is no endpoint that
 * can reveal it again; that is why the copy button and the warning are not
 * optional polish.
 */
async function viewTokens() {
  const [{ scopes, presets }, { tokens }] = await Promise.all([
    api("/tokens/scopes"),
    api("/tokens"),
  ]);

  const reload = async () => {
    $("view").replaceChildren(await viewTokens());
  };

  const name = el("input", { id: "token-name", type: "text", maxlength: "128", placeholder: "discord-bot" });
  const ttl = el("input", {
    id: "token-ttl",
    type: "number",
    min: "1",
    max: "3650",
    placeholder: "never expires",
  });

  // Grouped by area so "everything runs-related" is one glance rather than a
  // scan of a flat 15-item list.
  const boxes = new Map();
  const areas = new Map();
  for (const scope of scopes) {
    const area = scope.split(":")[0];
    if (!areas.has(area)) areas.set(area, []);
    areas.get(area).push(scope);
  }

  const scopeGroups = el(
    "div",
    { class: "grid" },
    [...areas].map(([area, list]) =>
      el(
        "div",
        { class: "stat" },
        el("div", { class: "k", text: area }),
        list.map((scope) => {
          const box = el("input", { type: "checkbox", id: `scope-${scope}`, value: scope });
          boxes.set(scope, box);
          return el("div", { class: "row tight" }, box, el("label", { for: `scope-${scope}`, text: scope }));
        }),
      ),
    ),
  );

  const setScopes = (wanted) => {
    const set = new Set(wanted);
    for (const [scope, box] of boxes) box.checked = set.has(scope);
  };

  const presetRow = row(
    el("span", { class: "dim", text: "Presets:" }),
    Object.entries(presets).map(([preset, list]) =>
      el("button", {
        type: "button",
        text: preset,
        title: list.join(", "),
        onclick: () => {
          setScopes(list);
          toast(`${preset}: ${list.length} scope(s) selected`);
        },
      }),
    ),
    el("button", { type: "button", text: "clear", onclick: () => setScopes([]) }),
  );

  const mint = card(
    "Mint a client token",
    el("p", {
      class: "dim",
      text:
        "One token per client, carrying only the scopes that client needs — a leaked credential is then confined " +
        "to its area. No token can mint another token or manage accounts, however broadly it is scoped.",
    }),
    row(
      el("label", { for: "token-name", text: "Client name" }),
      name,
      el("label", { for: "token-ttl", text: "Expires after (days)" }),
      ttl,
    ),
    presetRow,
    scopeGroups,
    row(
      el("button", {
        type: "button",
        class: "primary",
        text: "Mint token",
        onclick: async () => {
          const chosen = [...boxes].filter(([, box]) => box.checked).map(([scope]) => scope);
          if (!name.value.trim()) return toast("give the token a name first", false);
          if (!chosen.length) return toast("select at least one scope", false);
          const days = ttl.value === "" ? undefined : Number(ttl.value);
          if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 3650)) {
            return toast("expiry must be between 1 and 3650 days", false);
          }
          const minted = await act(
            "api_token.mint",
            () =>
              api("/tokens", {
                method: "POST",
                body: { name: name.value.trim(), scopes: chosen, ...(days ? { ttlDays: days } : {}) },
              }),
            { refresh: false },
          );
          if (minted) {
            showMintedToken(minted);
            name.value = "";
            ttl.value = "";
            setScopes([]);
            await reload();
          }
        },
      }),
    ),
  );

  const tokenState = (token) => {
    if (token.revoked) return "REVOKED";
    if (token.expiresAt && new Date(token.expiresAt) <= new Date()) return "FAILED";
    return "ACTIVE";
  };

  const rows = tokens.map((token) => [
    el(
      "div",
      {},
      el("div", { text: token.name }),
      el("div", { class: "dim", text: token.id }),
    ),
    chip(tokenState(token)),
    el("div", { class: "row tight" }, token.scopes.map((scope) => chip(scope))),
    token.createdBy,
    fmtTime(token.createdAt),
    token.lastUsedAt ? ago(token.lastUsedAt) : "never",
    token.expiresAt ? fmtTime(token.expiresAt) : "never",
    [
      token.revoked
        ? null
        : el("button", {
            type: "button",
            class: "danger",
            text: "Revoke",
            onclick: () => {
              if (
                !confirmDestructive(
                  `Revoke "${token.name}"? It stops working immediately and cannot be restored — ` +
                    "rotation means minting a replacement first.",
                )
              ) {
                return;
              }
              void act("api_token.revoke", () => api(`/tokens/${token.id}/revoke`, { method: "POST", body: {} }), {
                refresh: false,
              }).then(reload);
            },
          }),
    ].filter(Boolean),
  ]);

  return el(
    "div",
    {},
    mint,
    card(
      "Issued tokens",
      el("p", {
        class: "dim",
        text: "Last-used is throttled to one write per token per minute, so treat it as approximate.",
      }),
      table(
        ["Client", "State", "Scopes", "Created by", "Created", "Last used", "Expires", ""],
        rows,
      ),
    ),
  );
}

function showMintedToken(minted) {
  const secret = el("pre", { text: minted.token });
  openModal(
    `Client token · ${minted.name}`,
    el(
      "div",
      {},
      el("p", {
        class: "error",
        text:
          "Shown once. Nothing can reveal it again — copy it now and hand it over through a private channel. " +
          "If you lose it, revoke this token and mint another.",
      }),
      secret,
      el("p", { class: "dim", text: `Scopes: ${minted.scopes.join(", ")}` }),
      el("p", {
        class: "dim",
        text: minted.expiresAt ? `Expires ${fmtTime(minted.expiresAt)}.` : "Does not expire.",
      }),
      row(
        el("button", {
          type: "button",
          class: "primary",
          text: "Copy token",
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(minted.token);
              toast("copied to clipboard");
            } catch {
              toast("clipboard blocked — select the text manually", false);
            }
          },
        }),
        el("button", { type: "button", text: "Done", onclick: closeModal }),
      ),
    ),
  );
}

// ------------------------------------------------------------------------ boot

async function boot() {
  $("login-form").addEventListener("submit", loginWithPassword);
  $("login-token-form").addEventListener("submit", loginWithToken);
  $("login-token-toggle").addEventListener("click", () => {
    const form = $("login-token-form");
    form.hidden = !form.hidden;
    if (!form.hidden) $("login-token").focus();
  });
  $("logout").addEventListener("click", logout);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.actor && state.tab === "overview") void renderTab();
  });
  // Pasted permalinks and the back button take the same path. Only while signed
  // in: a hash change on the login screen must not try to open anything.
  window.addEventListener("hashchange", () => {
    if (state.actor) void openPermalink();
  });

  // The session cookie is HttpOnly, so the only way to know whether we are
  // signed in — and as whom — is to ask the API.
  let me;
  try {
    me = await api("/session", { allow401: true });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return showLogin("");
    showLogin(err.message);
    return;
  }
  await showApp(me);
  // A permalink decides the first view; otherwise fall back to the default tab.
  // `openPermalink` renders whatever it opens, so rendering again would double
  // every request on the landing view.
  if (!(await openPermalink())) await renderTab();
}

void boot();
