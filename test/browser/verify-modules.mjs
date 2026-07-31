/** The two views that live in their own ES modules, loaded on demand. */
import { launch, ok, failureCount } from "./cdp.mjs";
const O = process.env.DASH_ORIGIN ?? "http://127.0.0.1:8101";
const browser = await launch();
const page = await browser.newPage();
await page.goto(`${O}/`, 1500);
await page.eval(`
  document.getElementById("login-email").value = "iam@ardax.dev";
  document.getElementById("login-password").value = "correct-horse-battery-staple";
  document.getElementById("login-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  return true;`);
await page.waitFor(`document.getElementById("app").hidden === false`);
await page.settle(1200);

const items = await page.eval(`return [...document.querySelectorAll(".nav a")].map((a) => a.textContent.trim());`);
console.log("sidebar:", JSON.stringify(items));
ok("Maintenance and Docs are in the sidebar", items.includes("Maintenance") && items.includes("Docs"), items.join(","));

for (const [hash, want] of [["#/maintenance", "Extension code on GitHub"], ["#/docs", "Documents"]]) {
  await page.goto(`${O}/${hash}`, 1000);
  try {
    await page.waitFor(`document.getElementById("view").textContent.includes(${JSON.stringify(want)})`,
      { timeout: 12000, label: `${hash} content` });
  } catch { /* reported below */ }
  const state = await page.eval(`return {
    nav: document.querySelector('.nav a[aria-current="page"]')?.textContent.trim() ?? null,
    text: document.getElementById("view").textContent.slice(0, 220),
    failed: document.getElementById("view").textContent.includes("could not be loaded") };`);
  console.log(`${hash}:`, JSON.stringify(state, null, 1));
  ok(`${hash} loads its module and renders`, state.text.includes(want) && !state.failed, state.text.slice(0, 120));
}

const errs = page.consoleLines.filter((l) => l.startsWith("pageerror"));
ok("no page errors from the module views", errs.length === 0, errs.slice(0, 2).join(" / "));
console.log(`\n${failureCount() ? `${failureCount()} FAILURE(S)` : "ALL CHECKS PASSED"}`);
await browser.close();
process.exit(failureCount() ? 1 : 0);
