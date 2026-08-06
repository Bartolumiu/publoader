/**
 * The self-service view: fetch from GitHub, restart, install an extension.
 *
 * Every control here changes what the platform runs, so the view is built around
 * two habits rather than around the endpoints:
 *
 *  - say what WOULD happen before doing it. The GitHub card reads the comparison
 *    first and offers a dry run; installing shows whether the new bundle actually
 *    became `latest`, because "is it live?" is always the next question.
 *  - never present a refusal as a result. A GitHub token that is missing, a repo
 *    that is unreachable and a bundle with no recorded commit each render as
 *    their own reason, not as "up to date".
 *
 * Self-contained: an optional `host` supplies the shell's helpers, and this file
 * falls back to its own if they are absent.
 */

const API = "/api/v1/admin";
const CSRF_HEADER = "x-requested-with";
const CSRF_VALUE = "publoader-dash";

/** Last status payload, so switching tabs does not force another GitHub read. */
const state = { status: null, busy: false };

// ------------------------------------------------------------- host fallbacks

function fallbackEl(tag, attrs, ...kids) {
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

async function fallbackApi(path, opts) {
  const options = opts || {};
  const init = {
    method: options.method || "GET",
    credentials: "same-origin",
    headers: { [CSRF_HEADER]: CSRF_VALUE, accept: "application/json", ...(options.headers || {}) },
  };
  if (options.body !== undefined) {
    if (options.raw) init.body = options.body;
    else {
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
  if (!res.ok) {
    const error = new Error((data && data.error) || `${res.status} ${res.statusText}`);
    error.status = res.status;
    error.body = data;
    throw error;
  }
  return data;
}

function helpers(host) {
  const el = host.el || fallbackEl;
  return {
    el,
    /** Optional: the shell's tab switcher, for the "Read the docs" button. */
    selectTab: host.selectTab,
    api: host.api || fallbackApi,
    card: host.card || ((title, ...kids) => el("div", { class: "card" }, title ? el("h2", { text: title }) : null, ...kids)),
    row: host.row || ((...kids) => el("div", { class: "row" }, ...kids)),
    toast: host.toast || ((message) => console.warn(message)),
    confirm: host.confirm || ((message) => window.confirm(message)),
    can: host.can || (() => true),
    table:
      host.table ||
      ((headers, rows) =>
        rows.length === 0
          ? el("p", { class: "dim", text: "Nothing here." })
          : el(
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
                            : el("td", { text: cell == null || cell === "" ? "-" : cell }),
                      ),
                    ),
                  ),
                ),
              ),
            )),
  };
}

const short = (sha) => (sha ? String(sha).slice(0, 7) : "-");

// -------------------------------------------------------------------- the view

export async function viewSysops(host = {}) {
  const h = helpers(host);
  const { el, card } = h;
  const view = el("div", { class: "stack" });

  const github = card("Extension code on GitHub");
  const restart = card("Restart a service");
  const install = card("Install an extension");
  const docs = card("Documentation");
  view.append(github, install, restart, docs);

  renderGithub(h, github);
  renderInstall(h, install);
  renderRestart(h, restart);
  renderDocs(h, docs);
  return view;
}

// --------------------------------------------------------------- github card

function renderGithub(h, host) {
  const { el, api, row, table, toast, confirm } = h;
  const body = el("div", { class: "stack" });
  const status = el("p", { class: "dim", text: "Not checked yet." });

  const check = el("button", {
    type: "button",
    text: "Check GitHub for changes",
    onclick: () => void load(),
  });
  const dryRun = el("button", { type: "button", text: "Dry run", disabled: true, onclick: () => void sync(true) });
  const syncAll = el("button", {
    type: "button",
    class: "danger",
    text: "Fetch and publish",
    disabled: true,
    onclick: () => void sync(false),
  });

  host.append(
    el("p", {
      class: "dim",
      text:
        "Compares the commit each live bundle was built from against the default branch of every " +
        "configured extensions repository. Publishing runs the same build the push webhook does.",
    }),
    row(check, dryRun, syncAll),
    status,
    body,
  );

  if (state.status) draw(state.status);

  async function load() {
    check.disabled = true;
    status.className = "dim";
    status.textContent = "Asking GitHub…";
    try {
      state.status = await api("/sysops/github/status");
      draw(state.status);
    } catch (err) {
      status.className = "error";
      status.textContent = err.message;
      body.replaceChildren();
    } finally {
      check.disabled = false;
    }
  }

  function draw(payload) {
    if (!payload.available) {
      status.className = "error";
      // The refusal is the answer; it must not be mistaken for "all current".
      status.textContent = `Cannot tell: ${payload.reason || "GitHub is unavailable."}`;
      dryRun.disabled = true;
      syncAll.disabled = true;
      body.replaceChildren(reposTable(payload.repos));
      return;
    }

    const behind = payload.extensions.filter((entry) => entry.behind === true);
    const unknown = payload.extensions.filter((entry) => entry.behind === null);
    status.className = behind.length > 0 ? "warn" : "dim";
    status.textContent =
      `${behind.length} behind · ${payload.extensions.length - behind.length - unknown.length} current` +
      `${unknown.length > 0 ? ` · ${unknown.length} unknown` : ""}` +
      `${payload.authenticated ? "" : " · no GITHUB_TOKEN (anonymous rate limit)"}` +
      `${payload.truncated ? " · list truncated by the API call budget" : ""}`;
    dryRun.disabled = behind.length === 0;
    syncAll.disabled = behind.length === 0;

    body.replaceChildren(
      table(
        ["Extension", "Published", "From", "Repo HEAD", "State", ""],
        payload.extensions.map((entry) => [
          entry.extension,
          entry.publishedVersion,
          short(entry.publishedCommit),
          short(entry.latestCommit),
          stateCell(entry),
          entry.behind === true
            ? [
                el("button", {
                  type: "button",
                  text: "Fetch this one",
                  onclick: () => void sync(false, [entry.extension]),
                }),
              ]
            : [],
        ]),
      ),
      reposTable(payload.repos),
    );
  }

  function stateCell(entry) {
    if (entry.behind === true) {
      const changed = entry.changedPaths || [];
      return el(
        "span",
        {},
        el("span", { class: "chip warn", text: "behind" }),
        el("span", {
          class: "dim",
          text: changed.length > 0 ? ` ${changed.length} file(s) changed` : entry.reason ? ` ${entry.reason}` : "",
        }),
      );
    }
    if (entry.behind === false) return el("span", { class: "chip ok", text: "current" });
    return el(
      "span",
      {},
      el("span", { class: "chip", text: "unknown" }),
      el("span", { class: "dim", text: ` ${entry.reason || ""}` }),
    );
  }

  function reposTable(repos) {
    return el(
      "details",
      {},
      el("summary", { text: "Repositories" }),
      table(
        ["Repo", "Default branch", "HEAD", "Problem"],
        (repos || []).map((repo) => [repo.repo, repo.defaultBranch, short(repo.sha), repo.error]),
      ),
    );
  }

  async function sync(isDryRun, extensions) {
    if (
      !isDryRun &&
      !confirm(
        "Publish new bundles from GitHub? Every scheduled run after this uses the new code on every worker.",
      )
    ) {
      return;
    }
    dryRun.disabled = true;
    syncAll.disabled = true;
    try {
      const result = await api("/sysops/github/sync", {
        method: "POST",
        body: { dryRun: isDryRun, ...(extensions ? { extensions } : {}) },
      });
      body.replaceChildren(outcomesTable(h, result.outcomes), body.lastChild || el("span", {}));
      toast(
        isDryRun
          ? "Dry run complete; nothing was published."
          : `Published ${result.outcomes.filter((o) => o.status === "published").length} bundle(s).`,
        result.ok !== false,
      );
      if (!isDryRun) await load();
    } catch (err) {
      toast(err.message, false);
    } finally {
      dryRun.disabled = false;
      syncAll.disabled = false;
    }
  }
}

function outcomesTable(h, outcomes) {
  const { el, table } = h;
  return el(
    "div",
    {},
    el("h3", { text: "Result" }),
    table(
      ["Extension", "Outcome", "Version", "sha256", "Live?", "Detail"],
      outcomes.map((outcome) => [
        outcome.extension,
        el("span", { class: `chip ${outcomeTone(outcome.status)}`, text: outcome.status }),
        outcome.version,
        short(outcome.sha256),
        outcome.isLatest === undefined ? "-" : outcome.isLatest ? "yes" : "no (older version)",
        outcome.detail,
      ]),
    ),
  );
}

function outcomeTone(status) {
  if (status === "published") return "ok";
  if (status === "current" || status === "unchanged") return "";
  if (status === "failed") return "bad";
  return "warn";
}

// -------------------------------------------------------------- install card

function renderInstall(h, host) {
  const { el, api, row, toast } = h;
  const result = el("div", {});

  const repo = el("input", { type: "text", placeholder: "owner/repo or repo", "aria-label": "Repository" });
  const ref = el("input", { type: "text", placeholder: "branch, tag or sha (optional)", "aria-label": "Ref" });
  const path = el("input", { type: "text", placeholder: "src/<name> (optional)", "aria-label": "Path in repo" });
  const fromGithub = el("button", {
    type: "button",
    text: "Fetch, build and publish",
    onclick: () => void installGithub(),
  });

  const file = el("input", { type: "file", accept: ".zip,application/zip", "aria-label": "Extension zip" });
  const upload = el("button", { type: "button", text: "Upload and publish", onclick: () => void installUpload() });

  host.append(
    el("h3", { text: "From a GitHub repository" }),
    el("p", {
      class: "dim",
      text:
        "For an extension that is not in a configured repository yet. The commit is resolved and " +
        "recorded, so the update check can compare against it later.",
    }),
    row(repo, ref, path, fromGithub),
    el("h3", { text: "From a zip on this machine" }),
    el("p", {
      class: "dim",
      text:
        "manifest.json plus either a built index.mjs or the TypeScript source; the source is built " +
        "here with the same esbuild step the webhook uses. Zipping the folder itself is fine.",
    }),
    row(file, upload),
    result,
  );

  async function installGithub() {
    if (!repo.value.trim()) return toast("A repository is required.", false);
    fromGithub.disabled = true;
    result.replaceChildren(el("p", { class: "dim", text: "Fetching and building…" }));
    try {
      const body = { repo: repo.value.trim() };
      if (ref.value.trim()) body.ref = ref.value.trim();
      if (path.value.trim()) body.path = path.value.trim();
      show(await api("/sysops/extensions/install-github", { method: "POST", body }));
    } catch (err) {
      showError(err);
    } finally {
      fromGithub.disabled = false;
    }
  }

  async function installUpload() {
    const chosen = file.files && file.files[0];
    if (!chosen) return toast("Choose a zip first.", false);
    upload.disabled = true;
    result.replaceChildren(el("p", { class: "dim", text: `Uploading ${chosen.name}…` }));
    try {
      show(
        await api("/sysops/extensions/install-upload", {
          method: "POST",
          raw: true,
          headers: { "content-type": "application/zip" },
          body: await chosen.arrayBuffer(),
        }),
      );
    } catch (err) {
      showError(err);
    } finally {
      upload.disabled = false;
    }
  }

  function show(payload) {
    result.replaceChildren(outcomesTable(h, [payload]));
    toast(
      payload.isLatest
        ? `${payload.extension} ${payload.version} is now the version every new run will use.`
        : `${payload.extension} ${payload.version} was published but is NOT the latest version.`,
      payload.isLatest !== false,
    );
  }

  function showError(err) {
    const candidates = err.body && err.body.candidates;
    result.replaceChildren(
      el("p", { class: "error", text: err.message }),
      candidates
        ? el(
            "ul",
            {},
            candidates.map((candidate) => el("li", { text: candidate })),
          )
        : null,
    );
    toast(err.message, false);
  }
}

// -------------------------------------------------------------- restart card

function renderRestart(h, host) {
  const { el, api, row, toast, confirm } = h;
  const outcome = el("p", { class: "dim" });

  const target = el(
    "select",
    { "aria-label": "Service to restart" },
    ["all", "api", "scheduler", "processor", "uploader"].map((value) =>
      el("option", { value, text: value === "all" ? "the whole service (all four)" : `core-${value}` }),
    ),
  );

  host.append(
    el("p", {
      class: "dim",
      text:
        "A restart is a graceful exit: the service finishes what it is doing, shuts down cleanly, and " +
        "the container runtime starts it again. This needs a restart policy; with `docker run` and no " +
        "--restart, or a compose file without one, the service will stay down.",
    }),
    row(
      target,
      el("button", { type: "button", class: "danger", text: "Restart", onclick: () => void go() }),
    ),
    outcome,
  );

  async function go() {
    const chosen = target.value;
    if (
      !confirm(
        `Restart ${chosen === "all" ? "every core service" : `core-${chosen}`}? ` +
          "In-flight work is finished first, but the dashboard will be briefly unavailable.",
      )
    ) {
      return;
    }
    outcome.className = "dim";
    outcome.textContent = "Requesting…";
    try {
      const res = await api("/sysops/restart", { method: "POST", body: { target: chosen } });
      outcome.textContent = res.note;
      toast(`Restart requested for ${chosen}.`);
      if (res.exitingNow && res.exitingNow.length > 0) await waitForApi();
    } catch (err) {
      outcome.className = "error";
      outcome.textContent = err.message;
      toast(err.message, false);
    }
  }

  /**
   * Watch for the API to come back and reload once it does.
   *
   * Without this the operator is left on a dead page wondering whether the
   * restart worked; and a failed reload after ~30s is itself the answer that
   * the restart policy is missing, which is the one failure mode of this feature.
   */
  async function waitForApi() {
    outcome.className = "dim";
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      outcome.textContent = `Waiting for the API to come back (${attempt + 1}s)…`;
      try {
        const res = await fetch("/healthz", { cache: "no-store" });
        if (res.ok) {
          outcome.textContent = "Back up. Reloading…";
          window.location.reload();
          return;
        }
      } catch {
        // Expected while the process is down.
      }
    }
    outcome.className = "error";
    outcome.textContent =
      "The API did not come back within 30 seconds. If this deployment has no container restart " +
      "policy, it will not come back on its own; start it from the host.";
  }
}

// ----------------------------------------------------------------- docs card

function renderDocs(h, host) {
  const { el, row } = h;
  host.append(
    el("p", {
      class: "dim",
      text: "The operator handbook that ships with this build: deployment, operations, data model, extensions.",
    }),
    row(
      el("button", {
        type: "button",
        text: "Read the docs",
        onclick: () => {
          // Decoupled from the shell on purpose: this module knows nothing about
          // how tabs are selected. The shell listens for this event (or passes a
          // `selectTab` in the host object).
          if (typeof h.selectTab === "function") h.selectTab("docs");
          else document.dispatchEvent(new CustomEvent("publoader:navigate", { detail: { tab: "docs" } }));
        },
      }),
    ),
  );
}

export default viewSysops;
