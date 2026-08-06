/**
 * The untracked edit flow, in detail.
 *
 * Specifically the two things the queue view cannot show: that a CONTRIBUTOR may
 * correct the local row but is refused the push to MangaDex *by role*, and that
 * both halves degrade with a readable reason while the endpoints are still
 * landing.
 */
import { launch, ok, failureCount } from "./cdp.mjs";

const O = process.env.DASH_ORIGIN ?? "http://127.0.0.1:8101";
const OWNER = { email: "iam@ardax.dev", password: "correct-horse-battery-staple" };
const CONTRIB = { email: "contrib@example.com", password: "contributor-password-1234" };

const browser = await launch();
const page = await browser.newPage();

const signIn = async ({ email, password }) => {
  await page.eval(`
    document.getElementById("login-email").value = ${JSON.stringify(email)};
    document.getElementById("login-password").value = ${JSON.stringify(password)};
    document.getElementById("login-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    return true;`);
  await page.waitFor(`document.getElementById("app").hidden === false`);
  await page.settle(1000);
};
const signOut = async () => {
  await page.eval(`document.getElementById("profile-toggle").click(); document.getElementById("logout").click(); return true;`);
  await page.waitFor(`document.getElementById("login").hidden === false`);
  await page.settle(300);
};

/** Open a row and wait for its form, rather than guessing a settle time. */
const openDetail = async (id) => {
  await page.goto(`${O}/#/untracked/${id}`, 600);
  await page.waitFor(`document.getElementById("untracked-name")`, {
    timeout: 15000,
    label: `untracked detail form for ${id}`,
  });
  await page.settle(400);
};

const probe = `return {
  banner: document.querySelector("#view .banner")?.textContent?.slice(0, 90) ?? null,
  state: [...document.querySelectorAll("#view dd")][0]?.textContent?.trim() ?? null,
  mdTitle: [...document.querySelectorAll("#view dd")][4]?.textContent?.trim() ?? null,
  name: document.getElementById("untracked-name")?.value ?? null,
  lang: document.getElementById("untracked-lang")?.value ?? null,
  url: document.getElementById("untracked-url")?.value ?? null,
  readonly: document.getElementById("untracked-name")?.readOnly ?? null,
  save: (() => { const b = [...document.querySelectorAll("#view button")].find((x) => x.textContent === "Save local row");
    return b ? { disabled: b.disabled, title: b.title } : null; })(),
  apply: (() => { const b = document.getElementById("apply-to-mangadex");
    return b ? { disabled: b.disabled, title: b.title } : null; })(),
  reasonOnPage: [...document.querySelectorAll("#view p.dim")].map((p) => p.textContent).join(" ") };`;

await page.goto(`${O}/`, 1500);
await signIn(OWNER);

// The seeded row that already has a MangaDex title; the only one for which the
// push is meaningful, so the only one that can prove the role gate.
const ids = await page.eval(`
  const r = await fetch("/api/v1/admin/untracked?limit=50", { headers: { "x-requested-with": "publoader-dash" } });
  const b = await r.json();
  return { tracked: b.untracked.find((u) => u.mdMangaId)?.id ?? null,
           fresh: b.untracked.find((u) => u.state === "NEW")?.id ?? null,
           names: b.untracked.map((u) => u.state + ":" + u.mangaName) };`);
console.log("seeded rows:", JSON.stringify(ids, null, 1));

console.log("\n=== owner, on a row that already has a MangaDex title ===");
await openDetail(ids.tracked);
const asOwner = await page.eval(probe);
console.log(JSON.stringify(asOwner, null, 1));
ok("the local row is editable", asOwner.readonly === false && asOwner.name !== null);
ok("save is offered", asOwner.save?.disabled === false);
ok("the MangaDex push is offered to an owner", asOwner.apply?.disabled === false, JSON.stringify(asOwner.apply));
ok(
  "the view says a title already exists and local edits do not reach it",
  (asOwner.banner ?? "").includes("MangaDex title already exists"),
  String(asOwner.banner),
);

console.log("\n=== the apply confirmation names the consequence ===");
const confirmText = await page.eval(`
  document.getElementById("apply-to-mangadex").click();
  await new Promise((r) => setTimeout(r, 600));
  const d = document.getElementById("modal");
  const out = { open: d.open, title: document.getElementById("modal-title").textContent,
    body: document.getElementById("modal-body").textContent,
    buttons: [...d.querySelectorAll("button")].map((b) => b.textContent) };
  d.close();
  return out;`);
console.log(JSON.stringify(confirmText, null, 1));
ok(
  "a confirmation appears before anything is pushed",
  confirmText.open && /public MangaDex entry/i.test(confirmText.title + confirmText.body),
  confirmText.title,
);
ok(
  "it says the change is public and irreversible from here",
  /for everyone/i.test(confirmText.body) && /cannot be undone from here/i.test(confirmText.body),
);
ok("it offers Cancel as well as the destructive action", confirmText.buttons.includes("Cancel"));

console.log("\n=== validation refuses bad input before it becomes a request ===");
const validation = await page.eval(`
  const requests = [];
  const real = window.fetch;
  window.fetch = (u, i) => { requests.push((i?.method ?? "GET") + " " + u); return real(u, i); };
  const set = (id, v) => { const n = document.getElementById(id); n.value = v; };
  set("untracked-name", "");
  set("untracked-lang", "English");
  set("untracked-url", "notaurl");
  [...document.querySelectorAll("#view button")].find((b) => b.textContent === "Save local row").click();
  await new Promise((r) => setTimeout(r, 700));
  const out = {
    errors: [...document.querySelectorAll("#view .field-error")].map((p) => p.textContent).filter(Boolean),
    invalid: [...document.querySelectorAll('#view [aria-invalid="true"]')].map((n) => n.id),
    describedBy: document.getElementById("untracked-name").getAttribute("aria-describedby"),
    patches: requests.filter((r) => r.startsWith("PATCH")),
    toast: [...document.querySelectorAll(".toast")].map((t) => t.textContent).join(" | ") };
  window.fetch = real;
  return out;`);
console.log(JSON.stringify(validation, null, 1));
ok("all three fields are reported invalid", validation.invalid.length === 3, validation.invalid.join(","));
ok("each says what is wrong", validation.errors.length === 3, validation.errors.join(" / "));
ok("the errors are wired up for a screen reader", validation.describedBy === "untracked-name-error");
ok("nothing was sent", validation.patches.length === 0, validation.patches.join(","));

console.log("\n=== a save round-trips through PATCH /untracked/:id ===");
const stamp = `Sakamoto Days ${Date.now() % 100000}`;
const saveAttempt = await page.eval(`
  document.getElementById("toasts").replaceChildren();
  const set = (id, v) => { const n = document.getElementById(id); n.value = v; };
  set("untracked-name", ${JSON.stringify("${stamp}")});
  set("untracked-lang", "en");
  set("untracked-url", "https://mangaplus.shueisha.co.jp/titles/92");
  [...document.querySelectorAll("#view button")].find((b) => b.textContent === "Save local row").click();
  await new Promise((r) => setTimeout(r, 2200));
  const r = await fetch("/api/v1/admin/untracked/" + ${JSON.stringify("${ids.tracked}")},
    { headers: { "x-requested-with": "publoader-dash" } });
  const body = r.ok ? await r.json() : null;
  return { toast: [...document.querySelectorAll(".toast")].map((t) => t.textContent).join(" | "),
           fieldNow: document.getElementById("untracked-name")?.value ?? null,
           persisted: (body?.untracked ?? body)?.mangaName ?? null,
           status: r.status };`.replace("${stamp}", stamp).replace("${ids.tracked}", ids.tracked));
console.log(JSON.stringify(saveAttempt, null, 1));
ok(
  "the correction reaches the server and comes back",
  saveAttempt.persisted === stamp,
  `persisted=${saveAttempt.persisted} wanted=${stamp} toast=${saveAttempt.toast}`,
);
ok("and the outcome is toasted", /untracked\.update: ok/.test(saveAttempt.toast), saveAttempt.toast);

console.log("\n=== a refused correction rolls the optimistic edit back ===");
const rollback = await page.eval(`
  document.getElementById("toasts").replaceChildren();
  const before = document.getElementById("untracked-name").value;
  const set = (id, v) => { const n = document.getElementById(id); n.value = v; };
  // A host the extension does not scrape: the server refuses this outright.
  set("untracked-url", "https://example.com/not-a-source");
  [...document.querySelectorAll("#view button")].find((b) => b.textContent === "Save local row").click();
  await new Promise((r) => setTimeout(r, 2200));
  return { before, urlNow: document.getElementById("untracked-url")?.value ?? null,
           nameNow: document.getElementById("untracked-name")?.value ?? null,
           toast: [...document.querySelectorAll(".toast")].map((t) => t.textContent).join(" | ") };`);
console.log(JSON.stringify(rollback, null, 1));
ok(
  "the refusal is shown with the server's own reason",
  /allowed_hosts|not in/.test(rollback.toast),
  rollback.toast,
);
ok(
  "and the row on screen is the stored one again, not the rejected edit",
  rollback.nameNow === rollback.before,
  JSON.stringify(rollback),
);

console.log("\n=== contributor, on the same row ===");
await signOut();
await signIn(CONTRIB);
await openDetail(ids.tracked);
const asContrib = await page.eval(probe);
console.log(JSON.stringify(asContrib, null, 1));
ok("a contributor can still edit the local row", asContrib.readonly === false && asContrib.name !== null);
ok("save is still offered", asContrib.save?.disabled === false, JSON.stringify(asContrib.save));
ok(
  "the MangaDex push is DISABLED for a contributor",
  asContrib.apply?.disabled === true,
  JSON.stringify(asContrib.apply),
);
ok(
  "and the reason names the role requirement in the tooltip",
  /limited to owners and admins/i.test(asContrib.apply?.title ?? ""),
  String(asContrib.apply?.title),
);
ok(
  "and again in visible text, not only a tooltip",
  /limited to owners and admins/i.test(asContrib.reasonOnPage),
  asContrib.reasonOnPage.slice(0, 160),
);
ok(
  "a contributor is told to ask an operator",
  /ask an operator to apply it/i.test(asContrib.reasonOnPage),
  asContrib.reasonOnPage.slice(0, 200),
);

console.log("\n=== the per-row endpoint is used when it exists, and its absence degrades ===");
const endpoint = await page.eval(`
  const r = await fetch("/api/v1/admin/untracked/" + ${JSON.stringify("PLACEHOLDER")},
    { headers: { "x-requested-with": "publoader-dash" } });
  return { status: r.status,
    banner: [...document.querySelectorAll("#view .banner")].map((b) => b.textContent).join(" | "),
    hasFields: Boolean(document.getElementById("untracked-name")) };`.replace("PLACEHOLDER", ids.tracked));
console.log(JSON.stringify(endpoint, null, 1));
ok(
  "the row renders either way",
  endpoint.hasFields,
  JSON.stringify(endpoint),
);
ok(
  endpoint.status === 200
    ? "GET /untracked/:id has landed, so no degradation banner is shown"
    : "GET /untracked/:id is absent, and the view says which half is missing",
  endpoint.status === 200
    ? !/no per-row endpoint yet/.test(endpoint.banner)
    : /no per-row endpoint yet/.test(endpoint.banner),
  `status=${endpoint.status} banner=${endpoint.banner.slice(0, 120)}`,
);

console.log(`\n${failureCount() ? `${failureCount()} FAILURE(S)` : "ALL CHECKS PASSED"}`);
await page.close();
await browser.close();
process.exit(failureCount() ? 1 : 0);
