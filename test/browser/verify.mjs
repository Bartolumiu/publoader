/**
 * Browser-driven verification of the redesigned dashboard, in real Chrome.
 *
 * A real engine rather than jsdom because the bug this replaces was a CSS
 * cascade defect that jsdom cannot see: jsdom does not implement origin
 * precedence, so it reported `display: none` for an element Chrome was painting.
 */
import { launch, ok, failureCount } from "./cdp.mjs";

const O = process.env.DASH_ORIGIN ?? "http://127.0.0.1:8101";
const ADMIN_TOKEN = "dev-admin-not-a-secret";
const OWNER = { email: "iam@ardax.dev", password: "correct-horse-battery-staple" };
const CONTRIB = { email: "contrib@example.com", password: "contributor-password-1234" };

const box = `(id) => { const n = document.getElementById(id); if (!n) return null;
  const r = n.getBoundingClientRect(); const s = getComputedStyle(n);
  return { hidden: n.hidden, display: s.display, painted: r.width > 0 && r.height > 0, h: Math.round(r.height) }; }`;

const browser = await launch();
const page = await browser.newPage();

const signInWithToken = async () => {
  await page.eval(`
    document.getElementById("login-token-toggle").click();
    document.getElementById("login-token").value = ${JSON.stringify(ADMIN_TOKEN)};
    document.getElementById("login-actor").value = "ardax";
    document.getElementById("login-token-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    return true;`);
  await page.waitFor(`document.getElementById("app").hidden === false`, { label: "app shown" });
  await page.settle(1200);
};

const signInWithPassword = async ({ email, password }) => {
  await page.eval(`
    document.getElementById("login-email").value = ${JSON.stringify(email)};
    document.getElementById("login-password").value = ${JSON.stringify(password)};
    document.getElementById("login-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    return true;`);
  await page.waitFor(`document.getElementById("app").hidden === false`, { label: "app shown" });
  await page.settle(1200);
};

const signOut = async () => {
  await page.eval(`document.getElementById("profile-toggle").click(); document.getElementById("logout").click(); return true;`);
  await page.waitFor(`document.getElementById("login").hidden === false`, { label: "login shown" });
  await page.settle(400);
};

// ===========================================================================
console.log("\n=== 1. admin-token sign-in transitions to the app ===");
// ===========================================================================
await page.goto(`${O}/`, 1500);
const before = await page.eval(`const b = ${box}; return { login: b("login"), app: b("app") };`);
console.log("before:", JSON.stringify(before));
ok("login card is the only thing on screen before sign-in", before.login.painted && !before.app.painted);

await signInWithToken();
const after = await page.eval(`const b = ${box}; return { login: b("login"), app: b("app"), pill: b("pause-pill") };`);
console.log("after: ", JSON.stringify(after));
ok("the app is on screen", after.app.painted && after.app.hidden === false);
ok(
  "the login card is gone; attribute AND layout (the reported bug)",
  after.login.hidden === true && after.login.display === "none" && !after.login.painted,
  `display=${after.login.display} painted=${after.login.painted} height=${after.login.h}px`,
);
console.log(
  "identity:",
  await page.eval(`return {
    whoami: document.getElementById("whoami").textContent,
    role: document.getElementById("role-badge").textContent,
    paused: document.getElementById("pause-pill").textContent,
    workers: document.getElementById("sum-workers").textContent,
    jobs: document.getElementById("sum-jobs").textContent,
    queue: document.getElementById("sum-queue").textContent,
    lastRun: document.getElementById("sum-run").textContent };`),
);
const nav = await page.eval(`return {
  groups: [...document.querySelectorAll(".nav-group h2")].map((h) => h.textContent),
  items: [...document.querySelectorAll(".nav a")].map((a) => a.textContent.trim()),
  current: document.querySelector('.nav a[aria-current="page"]')?.textContent.trim() ?? null,
  hash: location.hash };`);
console.log("sidebar:", JSON.stringify(nav));

// `replaceChildren` stringifies a null argument instead of skipping it, unlike
// the `append` helper, so a conditionally-built child painted a literal "null"
// before every page title. Assert the whole shell is free of the class, not just
// the one call site.
const stray = await page.eval(`return {
  head: document.getElementById("page-head").textContent.trim(),
  strayNull: /(^|\\s)(null|undefined|NaN)(\\s|$)/.test(document.getElementById("app").textContent) };`);
console.log("stray placeholder scan:", JSON.stringify(stray));
ok("no literal null/undefined/NaN painted anywhere in the shell", !stray.strayNull, stray.head);
ok("sidebar is grouped", nav.groups.join(",") === "Work,Catalogue,Fleet,Admin", nav.groups.join(","));
// 13 built into app.js plus the two that live in their own modules.
ok("an owner sees every destination", nav.items.length === 18, `${nav.items.length} items`);
ok(
  "including the two module-backed ones",
  nav.items.includes("Maintenance") && nav.items.includes("Docs"),
  nav.items.join(","),
);
ok("the current item is marked with aria-current", nav.current === "Overview", String(nav.current));
ok("landing on a canonical hash", nav.hash === "#/overview/platform", nav.hash);

// ===========================================================================
console.log("\n=== 2. the session survives a reload ===");
// ===========================================================================
await page.reload(1800);
const reloaded = await page.eval(`const b = ${box}; return {
  login: b("login"), app: b("app"), whoami: document.getElementById("whoami").textContent, hash: location.hash };`);
console.log("after reload:", JSON.stringify(reloaded));
ok("still signed in after a reload", reloaded.app.painted && !reloaded.login.painted && reloaded.whoami === "ardax");

// ===========================================================================
console.log("\n=== 3. a deep link restores the sidebar item AND the tab ===");
// ===========================================================================
for (const [hash, wantNav, wantTab] of [
  ["#/system/backup", "System", "Backup"],
  ["#/workers/enrolment", "Workers", "Enrolment"],
  ["#/queues/depth", "Queues", "Depth"],
  ["#/users/sessions", "Users", "Sessions"],
]) {
  await page.goto(`${O}/${hash}`, 1800);
  const got = await page.eval(`return {
    nav: document.querySelector('.nav a[aria-current="page"]')?.textContent.trim() ?? null,
    tab: document.querySelector('#tabs button[aria-selected="true"]')?.textContent ?? null,
    hash: location.hash,
    heading: document.querySelector("#page-head h1")?.textContent ?? null,
    viewText: (document.getElementById("view").textContent || "").slice(0, 60) };`);
  ok(
    `${hash} restores ${wantNav} / ${wantTab}`,
    got.nav === wantNav && got.tab === wantTab && got.hash === hash,
    JSON.stringify(got),
  );
}

// A three-segment deep link: section / param / tab.
await page.goto(`${O}/#/extensions/mangaplus/series-map`, 2200);
const nested = await page.eval(`return {
  nav: document.querySelector('.nav a[aria-current="page"]')?.textContent.trim() ?? null,
  crumb: document.querySelector("#page-head .crumb")?.textContent ?? null,
  heading: document.querySelector("#page-head h1")?.textContent ?? null,
  // The shell's tablist, the same place every other tabbed destination puts it.
  // This used to read '#view [role="tab"]': the shell suppressed its tabs on a
  // param route, so the extension detail view drew a second strip of its own
  // inside the view. That strip is gone, and the section's tabs now render in
  // the shell for a param route, which is where they belong.
  tab: document.querySelector('#tabs button[aria-selected="true"]')?.textContent ?? null,
  inViewTabs: document.querySelectorAll('#view [role="tab"]').length,
  hash: location.hash,
  cards: [...document.querySelectorAll("#view .card > h2")].map((h) => h.textContent) };`);
console.log("nested:", JSON.stringify(nested));
ok(
  "#/extensions/mangaplus/series-map restores Extensions + the Series map tab",
  nested.nav === "Extensions" && nested.tab === "Series map" && nested.heading === "mangaplus",
  JSON.stringify(nested),
);
ok(
  "and the detail view draws no tab strip of its own",
  nested.inViewTabs === 0,
  `${nested.inViewTabs} in-view tabs`,
);
ok(
  "the series-map view rendered its own panels",
  nested.cards.includes("Tracked series") && nested.cards.includes("Bulk curation"),
  nested.cards.join(" | "),
);

/*
 * The other half of the same fix. Overview, Series map, Schedule, Config and
 * Versions are sections of ONE extension, so on the bare list they named
 * nothing: `#/extensions` has no param, so the router blanked the selected tab
 * and `#/extensions/config` canonicalised straight back to `#/extensions`.
 * Five tabs, none selected, each bouncing the operator to where they already
 * were. Reported as "stuff that shows even though they are extension only".
 */
await page.goto(`${O}/#/extensions`, 2200);
const listTabs = await page.eval(`return {
  shellTabs: [...document.querySelectorAll("#tabs button")].map((b) => b.textContent),
  inViewTabs: document.querySelectorAll('#view [role="tab"]').length,
  hash: location.hash,
  cards: [...document.querySelectorAll("#view .card > h2")].map((h) => h.textContent) };`);
console.log("extensions list:", JSON.stringify(listTabs));
ok(
  "the extensions list offers no single-extension tabs",
  listTabs.shellTabs.length === 0 && listTabs.inViewTabs === 0,
  JSON.stringify(listTabs.shellTabs),
);
ok(
  "and it leads with the extension index, not with the platform defaults",
  listTabs.cards[0] === "Extensions",
  listTabs.cards.join(" | "),
);

// ===========================================================================
console.log("\n=== 4. the audit permalink opens one event ===");
// ===========================================================================
// The login above wrote session.login rows. Take the OLDEST id available, so
// the fix is exercised against an event that client-side filtering of the most
// recent page would still have found; then also prove the endpoint resolves an
// id that is off the first page entirely.
const auditIds = await page.eval(`
  const res = await fetch("/api/v1/admin/audit?limit=500", { headers: { "x-requested-with": "publoader-dash" } });
  const body = await res.json();
  return { total: body.total, first: body.events[0]?.id ?? null, oldest: body.events[body.events.length - 1]?.id ?? null,
           nextCursor: body.nextCursor, keys: Object.keys(body) };`);
console.log("audit index:", JSON.stringify(auditIds));

for (const [label, id] of [["newest", auditIds.first], ["oldest", auditIds.oldest]]) {
  await page.goto(`${O}/#/audit/${id}`, 1800);
  const detail = await page.eval(`return {
    nav: document.querySelector('.nav a[aria-current="page"]')?.textContent.trim() ?? null,
    heading: document.querySelector("#page-head h1")?.textContent ?? null,
    terms: [...document.querySelectorAll("#view dt")].map((d) => d.textContent),
    values: [...document.querySelectorAll("#view dd")].map((d) => d.textContent.trim()),
    detailJson: document.querySelector("#view pre")?.textContent?.slice(0, 120) ?? null,
    noMatch: document.getElementById("view").textContent.includes("No event with that id"),
    hash: location.hash };`);
  console.log(`${label} (${id}):`, JSON.stringify(detail, null, 1));
  ok(`the ${label} audit id opens a detail view, not "no matching events"`, !detail.noMatch);
  ok(
    `the ${label} detail view shows actor, action, subject and timestamp`,
    ["Event", "When", "Actor", "Action", "Subject"].every((t) => detail.terms.includes(t)),
    detail.terms.join(","),
  );
  ok(`the ${label} detail view pretty-prints the detail JSON`, detail.detailJson !== null, String(detail.detailJson));
}

// And the old permalink format, which people have already pasted into chat.
await page.goto(`${O}/#audit/${auditIds.oldest}`, 1800);
const legacy = await page.eval(`return { hash: location.hash,
  noMatch: document.getElementById("view").textContent.includes("No event with that id"),
  actor: [...document.querySelectorAll("#view dd")][2]?.textContent?.trim() ?? null };`);
ok(
  "a legacy #audit/<id> permalink still resolves",
  legacy.hash === `#/audit/${auditIds.oldest}` && !legacy.noMatch,
  JSON.stringify(legacy),
);

// A bad id has to say so rather than showing an empty list.
await page.goto(`${O}/#/audit/00000000-0000-4000-8000-000000000000`, 1500);
ok(
  "an unknown audit id says so",
  await page.eval(`return document.getElementById("view").textContent.includes("No event with that id");`),
);

// ===========================================================================
console.log("\n=== 5. email + password sign-in ===");
// ===========================================================================
await signOut();
await signInWithPassword(OWNER);
const pw = await page.eval(`const b = ${box}; return { login: b("login"), app: b("app"),
  whoami: document.getElementById("whoami").textContent, role: document.getElementById("role-badge").textContent };`);
console.log("owner via password:", JSON.stringify(pw));
ok("password sign-in reaches the app with the login card gone", pw.app.painted && !pw.login.painted);
ok("owner is badged as owner", pw.role === "owner", pw.role);

await signOut();
await signInWithPassword(CONTRIB);
const contrib = await page.eval(`return {
  items: [...document.querySelectorAll(".nav a")].map((a) => a.textContent.trim()),
  role: document.getElementById("role-badge").textContent,
  hash: location.hash };`);
console.log("contributor:", JSON.stringify(contrib));
// Docs is included: it needs stats:read, which a contributor holds, and the
// operator handbook is exactly what a new contributor should be able to read.
ok(
  "a contributor sees only the destinations it can open",
  contrib.items.join(",") === "Overview,Extensions,Tracked,Untracked,Docs",
  contrib.items.join(","),
);
ok(
  "and not the operator-only ones",
  !contrib.items.some((i) => ["Runs", "Queues", "Workers", "Users", "Tokens", "Audit", "System", "Maintenance"].includes(i)),
  contrib.items.join(","),
);

// A contributor may correct an untracked row but must not be offered the push.
const untracked = await page.eval(`
  const res = await fetch("/api/v1/admin/untracked?limit=5", { headers: { "x-requested-with": "publoader-dash" } });
  const body = await res.json();
  return body.untracked?.[0]?.id ?? null;`);
if (untracked) {
  await page.goto(`${O}/#/untracked/${untracked}`, 1800);
  const form = await page.eval(`return {
    name: document.getElementById("untracked-name")?.value ?? null,
    nameReadonly: document.getElementById("untracked-name")?.readOnly ?? null,
    apply: (() => { const b = document.getElementById("apply-to-mangadex");
      return b ? { disabled: b.disabled, title: b.title } : null; })(),
    reasonShown: document.getElementById("view").textContent.includes("limited to owners and admins")
      || document.getElementById("view").textContent.includes("approve the series first") };`);
  console.log("contributor untracked detail:", JSON.stringify(form, null, 1));
  ok("a contributor gets an editable local row", form.name !== null && form.nameReadonly === false);
  ok("the MangaDex push is disabled with a reason", form.apply?.disabled === true && Boolean(form.apply.title));
  ok("the reason is also written on the page", form.reasonShown);
} else {
  console.log("SKIP  untracked detail; no untracked rows in this database");
}

// A contributor following a link into an admin-only view must be told, not 403'd.
await page.goto(`${O}/#/tokens/mint`, 1500);
const refused = await page.eval(`return { hash: location.hash,
  nav: document.querySelector('.nav a[aria-current="page"]')?.textContent.trim() ?? null,
  toast: [...document.querySelectorAll(".toast")].map((t) => t.textContent).join(" | ") };`);
console.log("contributor -> #/tokens/mint:", JSON.stringify(refused));
ok(
  "a link into a destination this account cannot open is refused with an explanation",
  refused.toast.includes("cannot open") && refused.nav === "Overview",
  JSON.stringify(refused),
);

// ===========================================================================
console.log("\n=== 6. responsive + no sideways page scroll ===");
// ===========================================================================
await signOut();
await signInWithPassword(OWNER);
await page.goto(`${O}/#/audit`, 2000);

for (const [w, h, label] of [[1400, 900, "desktop"], [820, 900, "tablet"], [390, 780, "iPhone"]]) {
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: w, height: h, deviceScaleFactor: 1, mobile: w < 700,
  });
  await page.settle(500);
  const layout = await page.eval(`return {
    bodyScrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth,
    sidebarPainted: document.getElementById("sidebar").getBoundingClientRect().width > 0
      && document.getElementById("sidebar").getBoundingClientRect().left >= 0,
    hamburger: getComputedStyle(document.getElementById("nav-toggle")).display,
    tableStacked: (() => { const t = document.querySelector("#view table");
      return t ? getComputedStyle(t.querySelector("tbody tr")).display : null; })(),
    scrollerScrolls: (() => { const s = document.querySelector("#view .scroll");
      return s ? s.scrollWidth > s.clientWidth : null; })(),
    /* Rendered buttons only. Below 620px the header row is display:none and the
       sort buttons inside it collapse to 0x0; they are not painted and not
       focusable, so measuring them said "0px" about a control no thumb can
       reach. Filtering on offsetParent is what makes this measure the controls
       an operator actually taps. */
    minTouch: (() => {
      const shown = [...document.querySelectorAll("#view button")]
        .filter((b) => b.offsetParent !== null).slice(0, 12);
      return shown.length ? Math.min(...shown.map((b) => Math.round(b.getBoundingClientRect().height))) : null;
    })() };`);
  console.log(`${label} ${w}x${h}:`, JSON.stringify(layout));
  ok(
    `${label}: the page never scrolls sideways`,
    layout.bodyScrollW <= layout.clientW + 1,
    `scrollWidth=${layout.bodyScrollW} clientWidth=${layout.clientW}`,
  );
  if (w < 861) {
    ok(`${label}: the sidebar is an off-canvas drawer`, !layout.sidebarPainted && layout.hamburger !== "none");
  } else {
    ok(`${label}: the sidebar is on screen`, layout.sidebarPainted && layout.hamburger === "none");
  }
  if (w < 620) {
    ok(`${label}: table rows restack as cards`, layout.tableStacked === "block", String(layout.tableStacked));
    ok(`${label}: touch targets are at least 40px`, layout.minTouch >= 40, `${layout.minTouch}px`);
  }
}

// The drawer, opened and closed the way a thumb and a keyboard would.
await page.eval(`document.getElementById("nav-toggle").click(); return true;`);
await page.settle(400);
const opened = await page.eval(`return {
  open: document.body.classList.contains("nav-open"),
  left: Math.round(document.getElementById("sidebar").getBoundingClientRect().left),
  inert: document.getElementById("sidebar").hasAttribute("inert"),
  expanded: document.getElementById("nav-toggle").getAttribute("aria-expanded"),
  focusInDrawer: Boolean(document.activeElement.closest("#sidebar")) };`);
console.log("drawer open:", JSON.stringify(opened));
ok("the drawer opens, is not inert, and takes focus", opened.open && opened.left === 0 && !opened.inert && opened.focusInDrawer);

await page.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true;`);
await page.settle(400);
const closed = await page.eval(`return {
  open: document.body.classList.contains("nav-open"),
  inert: document.getElementById("sidebar").hasAttribute("inert"),
  expanded: document.getElementById("nav-toggle").getAttribute("aria-expanded") };`);
ok("Escape closes the drawer and makes it inert again", !closed.open && closed.inert && closed.expanded === "false", JSON.stringify(closed));

// ===========================================================================
console.log("\n=== 6b. the header poll does not steal keyboard focus ===");
// Back to desktop first: the section above leaves the viewport at 390px, where
// the sidebar is a closed drawer and correctly `inert`, so nothing in it can
// take focus.
await page.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
await page.goto(`${O}/#/overview/platform`, 1600);
const focusKept = await page.eval(`
  const link = [...document.querySelectorAll(".nav a")].find((a) => a.textContent.includes("Audit"));
  link.focus();
  const before = document.activeElement === link;
  const describe = () => {
    const a = document.activeElement;
    return a ? \`\${a.tagName}\${a.id ? "#" + a.id : ""}:\${(a.textContent || "").trim().slice(0, 20)}\` : "none";
  };
  const beforeWho = describe();
  // Two poll intervals, which used to rebuild the sidebar and drop focus to body.
  await new Promise((r) => setTimeout(r, 21000));
  return { before, beforeWho, afterWho: describe(),
           sameNode: document.activeElement === link,
           stillInNav: Boolean(document.activeElement.closest && document.activeElement.closest(".nav")) };`);
console.log("focus across two polls:", JSON.stringify(focusKept));
ok(
  "a nav link keeps focus across two header polls",
  focusKept.before && focusKept.sameNode && focusKept.stillInNav,
  JSON.stringify(focusKept),
);

console.log("\n=== 7. sidebar collapse is remembered ===");
// ===========================================================================
await page.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
await page.goto(`${O}/#/overview/platform`, 1600);
const widths = await page.eval(`
  const w = () => Math.round(document.getElementById("sidebar").getBoundingClientRect().width);
  const wide = w();
  document.getElementById("nav-collapse").click();
  await new Promise((r) => setTimeout(r, 250));
  return { wide, narrow: w(), stored: localStorage.getItem("publoader.nav.collapsed"),
           labelsHidden: getComputedStyle(document.querySelector(".nav-label")).display === "none" };`);
console.log("collapse:", JSON.stringify(widths));
ok("collapsing narrows the sidebar to icons", widths.narrow < widths.wide && widths.labelsHidden, JSON.stringify(widths));

await page.reload(1600);
const remembered = await page.eval(`return { collapsed: document.body.classList.contains("nav-collapsed"),
  width: Math.round(document.getElementById("sidebar").getBoundingClientRect().width) };`);
ok("the collapsed state survives a reload", remembered.collapsed && remembered.width < widths.wide, JSON.stringify(remembered));
await page.eval(`document.getElementById("nav-collapse").click(); return true;`);

// ===========================================================================
console.log("\n=== 8. loading / empty / error states, and a live mutation ===");
// ===========================================================================
await page.goto(`${O}/#/errors/quarantine`, 1800);
const emptyish = await page.eval(`return { text: document.querySelector("#view .empty")?.textContent?.trim() ?? null,
  hasTable: Boolean(document.querySelector("#view table")) };`);
console.log("empty state:", JSON.stringify(emptyish));
ok("an empty list says so in words", emptyish.text !== null && emptyish.text.length > 5, String(emptyish.text));

// Pause, then prove the header updated without a reload.
await page.goto(`${O}/#/overview/platform`, 1800);
const mutation = await page.eval(`
  const pillBefore = document.getElementById("pause-pill").textContent;
  [...document.querySelectorAll("#view button")].find((b) => b.textContent.trim() === "Pause").click();
  await new Promise((r) => setTimeout(r, 2500));
  return { pillBefore, pillAfter: document.getElementById("pause-pill").textContent,
           banner: document.querySelector("#view .banner")?.textContent?.slice(0, 60) ?? null,
           toast: [...document.querySelectorAll(".toast")].map((t) => t.textContent).join(" | ") };`);
console.log("pause:", JSON.stringify(mutation));
ok(
  "one mutation updates the header pill and the view together, with no reload",
  mutation.pillBefore === "running" && mutation.pillAfter === "paused" && mutation.banner?.includes("paused"),
  JSON.stringify(mutation),
);
const resumed = await page.eval(`
  [...document.querySelectorAll("#view button")].find((b) => b.textContent.trim() === "Resume").click();
  await new Promise((r) => setTimeout(r, 2500));
  return document.getElementById("pause-pill").textContent;`);
ok("and resuming puts it back", resumed === "running", resumed);

// A failing request has to offer a retry rather than a blank panel.
const errorState = await page.eval(`
  const real = window.fetch;
  window.fetch = async (u, i) => (String(u).includes("/schema") ? new Response('{"error":"boom"}', { status: 500 }) : real(u, i));
  location.hash = "#/system/schema";
  await new Promise((r) => setTimeout(r, 1500));
  const text = document.getElementById("view").textContent;
  window.fetch = real;
  return { hasRetry: [...document.querySelectorAll("#view button")].some((b) => b.textContent === "Try again"),
           says: text.includes("did not load"), message: text.includes("boom") };`);
console.log("error state:", JSON.stringify(errorState));
ok("a failed load shows the reason and a retry", errorState.hasRetry && errorState.says && errorState.message);

// ===========================================================================
console.log("\n=== 9. accessibility basics ===");
// ===========================================================================
await page.goto(`${O}/#/audit`, 1800);
const a11y = await page.eval(`return {
  skipLink: document.querySelector(".skip-link")?.getAttribute("href") ?? null,
  ariaCurrent: document.querySelectorAll('.nav a[aria-current="page"]').length,
  navLandmark: Boolean(document.querySelector("aside[aria-label]")) && Boolean(document.querySelector("header.topbar")),
  visibleMains: [...document.querySelectorAll("main")].filter((m) => !m.hidden).length,
  skipFocuses: (() => { document.querySelector(".skip-link").click();
    return document.activeElement.id === "view" && location.hash.startsWith("#/"); })(),
  unlabelledInputs: [...document.querySelectorAll("#view input, #view select, #view textarea")]
    .filter((n) => !n.getAttribute("aria-label") && !n.id) .length,
  labelledByFor: [...document.querySelectorAll("#view input[id]")]
    .filter((n) => !n.getAttribute("aria-label") && !document.querySelector('label[for="' + n.id + '"]')).length,
  tablistRole: document.querySelector("#tabs")?.getAttribute("role") ?? null };`);
console.log("a11y:", JSON.stringify(a11y));
ok("exactly one nav item is aria-current", a11y.ariaCurrent === 1);
ok(
  "there is a skip link and exactly one visible main landmark",
  a11y.skipLink === "#view" && a11y.navLandmark && a11y.visibleMains === 1,
  JSON.stringify(a11y),
);
ok("the skip link moves focus without hijacking the route", a11y.skipFocuses, JSON.stringify(a11y));
ok("every control in the view is labelled", a11y.unlabelledInputs === 0 && a11y.labelledByFor === 0, JSON.stringify(a11y));

// A dialog has to trap focus and close on Escape.
await page.goto(`${O}/#/workers/enrolment`, 1800);
const dialog = await page.eval(`
  [...document.querySelectorAll("#view button")].find((b) => b.textContent.includes("Mint enrolment token")).click();
  await new Promise((r) => setTimeout(r, 1500));
  const d = document.getElementById("modal");
  const inside = Boolean(document.activeElement.closest("#modal"));
  const title = document.getElementById("modal-title").textContent;
  d.dispatchEvent(new KeyboardEvent("cancel"));
  return { open: d.open, inside, title };`);
console.log("dialog:", JSON.stringify(dialog));
ok("a dialog opens with focus inside it", dialog.open && dialog.inside, JSON.stringify(dialog));
const escaped = await page.eval(`
  const d = document.getElementById("modal");
  d.close();
  await new Promise((r) => setTimeout(r, 200));
  return { open: d.open, bodyEmpty: document.getElementById("modal-body").childElementCount === 0 };`);
ok("closing it clears the dialog", !escaped.open && escaped.bodyEmpty, JSON.stringify(escaped));

// ===========================================================================
console.log("\n=== 10. every destination renders, with no page errors ===");
// ===========================================================================
const hashes = [
  "#/overview/platform", "#/overview/mangadex", "#/runs/recent", "#/runs/dead-letter",
  "#/queues/tasks", "#/queues/depth", "#/activity", "#/errors/failures", "#/errors/quarantine",
  "#/extensions", "#/tracked", "#/untracked", "#/workers/fleet", "#/workers/enrolment",
  "#/users/accounts", "#/users/sessions", "#/users/signups", "#/tokens/issued", "#/tokens/mint",
  "#/audit", "#/system/schema", "#/system/mangadex", "#/system/cards", "#/system/backup",
  "#/maintenance", "#/docs",
];
for (const hash of hashes) {
  await page.goto(`${O}/${hash}`, hash === "#/maintenance" || hash === "#/docs" ? 3000 : 1400);
  const state = await page.eval(`return { kids: document.getElementById("view").childElementCount,
    text: (document.getElementById("view").textContent || "").trim().length,
    err: document.getElementById("view").textContent.includes("did not load"),
    hash: location.hash };`);
  ok(`${hash} renders`, state.kids > 0 && state.text > 20 && !state.err && state.hash === hash, JSON.stringify(state));
}

const noisy = page.consoleLines.filter(
  (l) => !l.includes("401") && !l.includes("404") && !l.includes("Unauthorized") && !l.includes("boom") && !l.includes("500"),
);
console.log("\nunexpected console output:", noisy.length ? noisy.slice(0, 10).join("\n") : "(none)");
ok("no unexpected page errors", noisy.filter((l) => l.startsWith("pageerror")).length === 0, noisy.slice(0, 3).join(" / "));

console.log(`\n${failureCount() ? `${failureCount()} FAILURE(S)` : "ALL CHECKS PASSED"}`);
await page.close();
await browser.close();
process.exit(failureCount() ? 1 : 0);
