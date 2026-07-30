/**
 * The four operator features added after the redesign, in real Chrome.
 *
 * Each of these is a control that mutates the platform, so the assertions are
 * about two things: that the UI renders against the real endpoint shapes, and
 * that its guards actually refuse. A screenshot-level "it appears" is not enough
 * for a purge button.
 */
import { launch, ok, failureCount } from "./cdp.mjs";

const O = process.env.DASH_ORIGIN ?? "http://127.0.0.1:8101";
const ADMIN_TOKEN = "dev-admin-not-a-secret";

const browser = await launch();
const page = await browser.newPage();

await page.goto(`${O}/`, 1500);
await page.eval(`
  document.getElementById("login-token-toggle").click();
  document.getElementById("login-token").value = ${JSON.stringify(ADMIN_TOKEN)};
  document.getElementById("login-actor").value = "ardax";
  document.getElementById("login-token-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  return true;`);
await page.waitFor(`document.getElementById("app").hidden === false`, { label: "app shown" });
await page.settle(1200);

const go = async (hash) => {
  await page.eval(`window.location.hash = ${JSON.stringify(hash)}; return true;`);
  await page.settle(1200);
};

/** Text of the whole content area, for coarse presence checks. */
const contentText = () => page.eval(`return document.getElementById("view")?.textContent ?? ""`);

/** Every network call the page makes from now on, so a guard can be proven. */
const recordRequests = async () => {
  await page.eval(`
    window.__calls = [];
    if (!window.__fetchPatched) {
      window.__fetchPatched = true;
      const real = window.fetch;
      window.fetch = (url, init = {}) => {
        window.__calls.push((init.method || "GET") + " " + String(url));
        return real(url, init);
      };
    }
    return true;`);
};
const calls = () => page.eval(`return window.__calls || []`);

// ===========================================================================
console.log("\n=== 1. worker → extension assignment ===");

await go("#/workers");
const workersText = await contentText();
ok("the fleet table has an Extensions column", /Extensions/.test(workersText));

const hasWorker = await page.eval(
  `return !!document.querySelector("table tbody tr") && !/No worker has enrolled/.test(document.getElementById("view").textContent)`,
);

if (hasWorker) {
  const opened = await page.eval(`
    const b = [...document.querySelectorAll("button")].find((n) => n.textContent.trim() === "Change");
    if (!b) return "no Change button";
    b.click();
    return "clicked";`);
  ok("each worker offers a Change control for its extensions", opened === "clicked", String(opened));
  await page.settle(900);

  const dialog = await page.eval(`
    const d = document.getElementById("modal");
    return { open: !!d && d.open, title: document.getElementById("modal-title")?.textContent ?? "",
             any: !!document.getElementById("assign-any"), some: !!document.getElementById("assign-some"),
             text: document.getElementById("modal-body")?.textContent ?? "" };`);
  ok("the assignment dialog opens", dialog.open, dialog.title);
  ok(
    "it states the two choices explicitly rather than leaving empty checkboxes ambiguous",
    dialog.any && dialog.some,
    `any=${dialog.any} some=${dialog.some}`,
  );
  ok(
    "it says the change needs no restart or re-enrolment",
    /next poll/i.test(dialog.text),
    dialog.text.slice(0, 90),
  );

  await page.eval(`document.getElementById("modal").close(); return true;`);
} else {
  ok("no worker enrolled, so the assignment dialog is not reachable in this run", true, "skipped");
}

// ===========================================================================
console.log("\n=== 2. queue management ===");

await go("#/queues");
const queueText = await contentText();

for (const [label, present] of [
  ["a dedupe-key filter", /Dedupe key/.test(queueText)],
  ["an attempt-range filter", /Attempts ≥/.test(queueText)],
  ["a purge control", /Purge/.test(queueText)],
  ["a bulk selection bar", /Tick rows to act on them|selected/.test(queueText)],
]) {
  ok(`the queue view offers ${label}`, present);
}

const bulkDisabled = await page.eval(`
  const names = ["Retry", "Remove", "Run next", "Run last", "Defer…"];
  const found = [...document.querySelectorAll("button")].filter((b) => names.includes(b.textContent.trim()));
  return { count: found.length, allDisabled: found.length > 0 && found.every((b) => b.disabled) };`);
ok(
  "bulk actions exist and are disabled with nothing selected",
  bulkDisabled.count >= 4 && bulkDisabled.allDisabled,
  JSON.stringify(bulkDisabled),
);

// Paging is keyset: the pager reports the claim order the server named, so a
// reorder can be checked against the same ordering it rewrites.
ok("the pager names the claim order", /claim order/.test(queueText), queueText.slice(0, 0) || "");

await recordRequests();
const purgeOpened = await page.eval(`
  const b = [...document.querySelectorAll("button")].find((n) => n.textContent.trim().startsWith("Purge"));
  if (!b) return "no purge button";
  b.click();
  return "clicked";`);
ok("the purge dialog opens", purgeOpened === "clicked", String(purgeOpened));
await page.settle(700);

const purgeState = await page.eval(`
  const body = document.getElementById("modal-body");
  const apply = [...body.querySelectorAll("button")].find((b) => b.textContent.trim() === "Purge them");
  return { text: body.textContent, applyDisabled: apply ? apply.disabled : null,
           hasDryRun: [...body.querySelectorAll("button")].some((b) => b.textContent.trim() === "Dry run") };`);
ok("purge offers a dry run", purgeState.hasDryRun);
ok(
  "purge cannot be applied before a dry run has been done",
  purgeState.applyDisabled === true,
  `applyDisabled=${purgeState.applyDisabled}`,
);
ok(
  "purge warns what deleting a DONE row costs",
  /uploaded to MangaDex twice|uploaded twice/i.test(purgeState.text),
  purgeState.text.slice(0, 100),
);

// The dry run must be a real request, and must not delete anything.
await page.eval(`
  const b = [...document.getElementById("modal-body").querySelectorAll("button")].find((n) => n.textContent.trim() === "Dry run");
  b.click(); return true;`);
await page.settle(1200);
const afterDry = await calls();
const dryCall = afterDry.find((c) => c.includes("/queues/purge"));
ok("the dry run calls the purge endpoint", !!dryCall, String(dryCall));
const dryBody = await page.eval(`return document.getElementById("modal-body").textContent`);
ok(
  "the dry run reports what WOULD be deleted rather than deleting",
  /would be deleted|Nothing deletable/.test(dryBody),
  dryBody.slice(0, 120),
);

await page.eval(`document.getElementById("modal").close(); return true;`);

// ===========================================================================
console.log("\n=== 3. tracked series: catalogue column and repoint ===");

const ext = await page.eval(`
  return fetch("/api/v1/admin/extensions", { headers: { "x-requested-with": "publoader-dash" } })
    .then((r) => r.json()).then((d) => (d.extensions && d.extensions[0] ? d.extensions[0].name : null));`);

if (ext) {
  await go(`#/extensions/${ext}/series-map`);
  const trackedText = await contentText();
  ok("the tracked table has a Catalogue column", /Catalogue/.test(trackedText));
  ok(
    "the add form takes a catalogue",
    await page.eval(`return !!document.getElementById("tracked-namespace")`),
  );
  ok(
    "known catalogues are offered as suggestions",
    await page.eval(`return !!document.getElementById("tracked-namespaces")`),
  );

  const repoint = await page.eval(`
    const b = [...document.querySelectorAll("button")].find((n) => n.textContent.trim() === "Repoint");
    if (!b) return "none";
    b.click(); return "clicked";`);
  if (repoint === "clicked") {
    await page.settle(700);
    const dialogText = await page.eval(`return document.getElementById("modal-body")?.textContent ?? ""`);
    ok("the repoint dialog opens", /New MangaDex id/.test(dialogText));
    ok(
      "it says nothing on MangaDex is deleted, only where future chapters go",
      /Nothing on MangaDex is changed or deleted/.test(dialogText),
      dialogText.slice(0, 100),
    );
    ok(
      "it prefills the current target so a repoint is a change, not a retype",
      await page.eval(`return (document.getElementById("repoint-md-id")?.value ?? "").length > 0`),
    );
    await page.eval(`document.getElementById("modal").close(); return true;`);
  } else {
    ok("no tracked row to repoint in this run", true, "skipped");
  }

  // =========================================================================
  console.log("\n=== 4. typed config editor ===");

  await go(`#/extensions/${ext}/config`);
  await page.settle(1000);
  const configText = await contentText();

  for (const heading of ["Chapter aliases", "Multi-chapter numbers", "Language overrides"]) {
    ok(`the config editor has a typed list for ${heading}`, configText.includes(heading));
  }
  ok(
    "extension-private settings stay free-form",
    /Extension-private settings/.test(configText) &&
      (await page.eval(`return !!document.getElementById("config-passthrough")`)),
  );
  ok(
    "the old single JSON textarea is gone",
    await page.eval(`return !document.getElementById("config-json")`),
  );
  ok(
    "MangaDex language codes are offered from the server's own allowlist",
    await page.eval(`return (document.getElementById("md-languages")?.children.length ?? 0) > 10`),
  );

  // The validation the JSON box could not do: a bad language code is refused in
  // the editor, before the save that the server would reject.
  const validation = await page.eval(`
    const add = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Add a language");
    if (!add) return "no add button";
    add.click();
    const rows = document.querySelectorAll(".relation .relation-row");
    const last = rows[rows.length - 1];
    const inputs = last.querySelectorAll("input");
    inputs[0].value = "jp";
    inputs[0].dispatchEvent(new Event("input", { bubbles: true }));
    inputs[1].value = "not-a-language";
    inputs[1].dispatchEvent(new Event("input", { bubbles: true }));
    return last.querySelector(".field-error")?.textContent ?? "";`);
  ok(
    "a language code MangaDex does not accept is refused in the editor",
    /not a MangaDex language code/.test(String(validation)),
    String(validation).slice(0, 80),
  );

  const accepted = await page.eval(`
    const rows = document.querySelectorAll(".relation .relation-row");
    const last = rows[rows.length - 1];
    const inputs = last.querySelectorAll("input");
    inputs[1].value = "ja";
    inputs[1].dispatchEvent(new Event("input", { bubbles: true }));
    return last.querySelector(".field-error")?.textContent ?? "";`);
  ok("a real MangaDex code is accepted", accepted === "", String(accepted));
} else {
  ok("no extension published, so tracked and config panels are unreachable", true, "skipped");
}

// ===========================================================================
const errors = await page.eval(`return window.__pageErrors ? window.__pageErrors.length : 0`);
ok("no page errors across the four features", Number(errors) === 0, `errors=${errors}`);

await browser.close();
console.log(failureCount() ? "\nSOME CHECKS FAILED" : "\nALL CHECKS PASSED");
process.exit(failureCount() ? 1 : 0);
