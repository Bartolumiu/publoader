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
 */

"use strict";

const API = "/api/v1/admin";
const CSRF_HEADER = "x-requested-with";
const CSRF_VALUE = "publoader-dash";
const REFRESH_MS = 10_000;

const state = { actor: null, role: null, userId: null, tab: "overview", timer: null, owner: false };

// The session payload's role says what the account is; `state.owner` says what
// the server actually answered when asked (see confirmOwner). Only the second
// one may gate UI, so the page never offers a control that 403s.
const isOwner = () => state.owner;

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
  constructor(status, message) {
    super(message);
    this.status = status;
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
  if (!res.ok) throw new ApiError(res.status, message);
  return data;
}

/**
 * Does account administration actually answer for us?
 *
 * A 403 from /users is the server's own statement that this principal is not an
 * owner, and it is the only signal the SPA can trust — the role in the session
 * payload describes the account, not what the endpoints behind the owner-only
 * views will do. Asking once at login keeps those views off the page entirely
 * rather than letting an operator click into a wall of 403s.
 */
async function confirmOwner() {
  try {
    await api("/users", { allow401: true, quiet: true });
    state.owner = true;
  } catch (err) {
    // A 403 is definitive. Anything else (500, offline) leaves us guessing, so
    // fall back to what the session claimed rather than hiding an owner's tabs.
    state.owner = err instanceof ApiError && err.status === 403 ? false : state.role === "OWNER";
  }
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
  state.owner = false;
  $("app").hidden = true;
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
  await confirmOwner();
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

const TABS = [
  ["overview", "Overview"],
  ["workers", "Workers"],
  ["extensions", "Extensions"],
  ["runs", "Runs"],
  ["queues", "Queues"],
  ["errors", "Errors"],
  ["untracked", "Untracked"],
  ["quarantine", "Quarantine"],
  ["audit", "Audit"],
  // Account administration and credential minting are the two things an ADMIN
  // cannot do. Hiding the tabs is cosmetic; the server enforces it on every
  // endpoint behind them.
  ["users", "Users", { owner: true }],
  ["tokens", "Tokens", { owner: true }],
];

const visibleTabs = () => TABS.filter(([, , opts]) => !opts || !opts.owner || isOwner());

function buildTabs() {
  if (!visibleTabs().some(([id]) => id === state.tab)) state.tab = "overview";
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
  workers: viewWorkers,
  extensions: viewExtensions,
  runs: viewRuns,
  queues: viewQueues,
  errors: viewErrors,
  untracked: viewUntracked,
  quarantine: viewQuarantine,
  audit: viewAudit,
  users: viewUsers,
  tokens: viewTokens,
};

async function renderTab() {
  const view = $("view");
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

  const controls = card(
    "Platform",
    stats.paused
      ? el("div", { class: "banner", text: "Scheduling is paused. No new jobs will be leased." })
      : null,
    row(
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
    ),
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
  const [{ extensions }, removal] = await Promise.all([api("/extensions"), api("/removal-mode")]);

  const modeSelect = el(
    "select",
    { id: "removal-mode", "aria-label": "Chapter removal mode" },
    removal.validModes.map((mode) =>
      el("option", { value: mode, text: mode, selected: mode === removal.mode }),
    ),
  );

  const file = el("input", { type: "file", id: "bundle-file", accept: ".zip,application/zip" });

  const settings = card(
    "Settings",
    row(
      el("label", { for: "removal-mode", text: "Chapter removal mode" }),
      modeSelect,
      el("button", {
        type: "button",
        text: "Save",
        onclick: () =>
          act("removal-mode.set", () => api("/removal-mode", { method: "POST", body: { mode: modeSelect.value } })),
      }),
    ),
    el("label", { for: "bundle-file", text: "Publish extension bundle (.zip)" }),
    row(
      file,
      el("button", {
        type: "button",
        text: "Publish",
        onclick: async () => {
          const chosen = file.files && file.files[0];
          if (!chosen) return toast("choose a bundle zip first", false);
          const buffer = await chosen.arrayBuffer();
          await act("bundle.publish", () =>
            api("/bundles", {
              method: "POST",
              raw: true,
              body: buffer,
              headers: { "content-type": "application/zip" },
            }),
          );
        },
      }),
    ),
  );

  const detail = el("div", { id: "ext-detail" });

  const rows = extensions.map((ext) => [
    ext.name,
    ext.version,
    el("code", { text: (ext.sha256 || "").slice(0, 12) }),
    fmtTime(ext.publishedAt),
    chip(ext.disabled ? "disabled" : "enabled"),
    [
      el("button", { type: "button", text: "Run", onclick: () => triggerRun(ext.name, "UPDATE") }),
      el("button", { type: "button", text: "Force", onclick: () => triggerRun(ext.name, "FORCE") }),
      el("button", { type: "button", class: "danger", text: "Clean", onclick: () => triggerRun(ext.name, "CLEAN") }),
      el("button", {
        type: "button",
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
        text: "Configure",
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
    settings,
    card("Published bundles", table(["Extension", "Version", "sha256", "Published", "State", ""], rows)),
    detail,
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

async function extensionDetail(name) {
  const encoded = encodeURIComponent(name);
  const [schedules, config, tracked] = await Promise.all([
    api("/schedules"),
    api(`/extensions/${encoded}/config`),
    api(`/extensions/${encoded}/tracked`),
  ]);

  return el(
    "div",
    {},
    el("h2", { text: `${name} configuration` }),
    scheduleCard(name, schedules),
    configCard(name, config),
    trackedCard(name, tracked.tracked),
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
      el("button", {
        type: "button",
        class: "primary",
        text: "Save override",
        onclick: () => {
          const body = { hour: Number(hour.value), minute: Number(minute.value) };
          if (day.value !== "") body.day = Number(day.value);
          void act("schedule.set", () =>
            api(`/schedules/${encodeURIComponent(name)}`, { method: "PUT", body }),
          );
        },
      }),
      el("button", {
        type: "button",
        text: "Remove override",
        onclick: () =>
          act("schedule.remove", () => api(`/schedules/${encodeURIComponent(name)}`, { method: "DELETE" })),
      }),
    ),
  );
}

function configCard(name, config) {
  const editor = el("textarea", {
    id: "config-json",
    spellcheck: "false",
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
    el("p", { class: "dim", text: "The database is the source of truth; this replaces the whole document." }),
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
      el("button", {
        type: "button",
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

function trackedCard(name, tracked) {
  const encoded = encodeURIComponent(name);
  const mangaId = el("input", { id: "tracked-manga-id", type: "text", placeholder: "external manga id" });
  const mdMangaId = el("input", { id: "tracked-md-id", type: "text", placeholder: "MangaDex UUID" });

  const rows = tracked.map((item) => [
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
      el("button", {
        type: "button",
        class: "danger",
        text: "Remove",
        onclick: () => {
          if (!confirmDestructive(`Stop tracking ${item.mangaId}? This does not touch MangaDex.`)) return;
          void act("tracked_manga.remove", async () => {
            await api(`/extensions/${encoded}/tracked/${encodeURIComponent(item.mangaId)}`, { method: "DELETE" });
            $("ext-detail").replaceChildren(await extensionDetail(name));
          }, { refresh: false });
        },
      }),
    ],
  ]);

  return card(
    "Tracked manga",
    row(
      el("label", { for: "tracked-manga-id", text: "External id" }),
      mangaId,
      el("label", { for: "tracked-md-id", text: "MangaDex id" }),
      mdMangaId,
      el("button", {
        type: "button",
        class: "primary",
        text: "Add / repoint",
        onclick: () =>
          act(
            "tracked_manga.set",
            async () => {
              await api(`/extensions/${encoded}/tracked`, {
                method: "PUT",
                body: { mangaId: mangaId.value.trim(), mdMangaId: mdMangaId.value.trim() },
              });
              $("ext-detail").replaceChildren(await extensionDetail(name));
            },
            { refresh: false },
          ),
      }),
    ),
    table(["External id", "MangaDex id", "Source", "Added", ""], rows),
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

async function viewAudit() {
  const limit = state.auditLimit || 100;
  const { events } = await api(`/audit?limit=${limit}`);

  const select = el(
    "select",
    {
      id: "audit-limit",
      "aria-label": "Number of audit events",
      onchange: (event) => {
        state.auditLimit = Number(event.target.value);
        void renderTab();
      },
    },
    [25, 50, 100, 250, 500].map((value) =>
      el("option", { value: String(value), text: String(value), selected: value === limit }),
    ),
  );

  const rows = events.map((event) => [
    fmtTime(event.createdAt),
    event.actor,
    event.action,
    event.subject,
    event.detail ? truncate(JSON.stringify(event.detail), 160) : "—",
  ]);

  return el(
    "div",
    {},
    card("Filter", row(el("label", { for: "audit-limit", text: "Events" }), select)),
    card(null, table(["When", "Actor", "Action", "Subject", "Detail"], rows)),
  );
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
    el("option", { value: "ADMIN", text: "ADMIN" }),
    el("option", { value: "OWNER", text: "OWNER" }),
  );

  const invite = card(
    "Invite an operator",
    el("p", {
      class: "dim",
      text: "Creates an approved account with no credentials. They get in by linking Discord with that email, or by you setting a password below.",
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
      el("button", {
        type: "button",
        text: user.role === "OWNER" ? "Make admin" : "Make owner",
        onclick: () =>
          act(
            "admin_user.role",
            () =>
              api(`/users/${user.id}/role`, {
                method: "POST",
                body: { role: user.role === "OWNER" ? "ADMIN" : "OWNER" },
              }),
            { refresh: false },
          ).then(reload),
      }),
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
  await renderTab();
}

void boot();
