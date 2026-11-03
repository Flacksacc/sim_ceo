import { chromium } from "playwright-core";
const WEB = (process.env.QA_WEB || "http://127.0.0.1:5168").replace(/\/+$/, "");
if (WEB.includes(":5173") || WEB.includes(":5080")) { console.log("FATAL refuse human ports " + WEB); process.exit(1); }
let pass = 0, fail = 0;
const bad = [];
function ok(n, c, e) { if (c) { pass++; console.log("  ok " + n); } else { fail++; bad.push(n); console.log("  FAIL " + n + (e ? " :: " + String(e).slice(0, 300) : "")); } }
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let profile = null;
let holdGate = null;
let remoteBumpPending = false;
let lastPostVersion = null;
let postCount = 0;
function nowIso() { return new Date().toISOString(); }
async function main() {
  const browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const fulfillJson = (route, status, obj) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(obj) });
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();
    if (path === "/api/auth/me") {
      const auth = req.headers()["authorization"] || "";
      if (auth === "Bearer token-B") return fulfillJson(route, 401, { error: "Authentication required." });
      return fulfillJson(route, 200, { user: "qa-owner", authenticated: false });
    }
    if (path === "/api/auth/status") return fulfillJson(route, 200, { authenticated: false });
    if (path === "/api/boards" && method === "GET") return fulfillJson(route, 200, []);
    if (path === "/api/profile" && method === "GET") {
      if (!profile) return fulfillJson(route, 404, { error: "No saved profile" });
      return fulfillJson(route, 200, Object.assign({}, profile, { source: "default" }));
    }
    if (path === "/api/profile" && method === "POST") {
      postCount++;
      let body = {};
      try { body = JSON.parse(req.postData() || "{}"); } catch (e) { body = {}; }
      lastPostVersion = body.version;
      if (holdGate) await new Promise((res) => holdGate.push(res));
      const want = body.version == null ? 0 : body.version;
      const cur = profile ? profile.version : 0;
      if (cur !== 0 && want !== cur) return fulfillJson(route, 409, { error: "Stale default profile; refresh and re-apply." });
      const v = cur + 1;
      profile = { id: profile ? profile.id : "prof-1", boardId: "00000000-0000-0000-0000-000000000000", version: v, name: body.name || "", roleLabel: body.roleLabel || "Board Lead", background: body.background || "", familiarTopics: body.familiarTopics || "", simplerTopics: body.simplerTopics || "", commPrefs: body.commPrefs || "", provenanceJson: "{}", updatedAt: nowIso() };
      return fulfillJson(route, 200, Object.assign({}, profile, { source: "default" }));
    }
    if (method === "GET") return fulfillJson(route, 404, { error: "qa-stub-missing" });
    return fulfillJson(route, 501, { error: "qa-unexpected-write" });
  });
  const name = page.getByLabel("Name");
  const role = page.getByLabel("Role label");
  const bg = page.getByLabel("Background");
  const fam = page.getByLabel("Subjects already familiar");
  const simp = page.getByLabel("Subjects needing simpler explanation");
  const comm = page.getByLabel("Communication preferences");
  const saveBtn = page.getByRole("button", { name: "Save profile" });
  const section = page.locator("section[aria-label=Profile]");
  await page.goto(WEB + "/#/profile");
  await page.getByRole("heading", { name: "Profile" }).first().waitFor({ timeout: 15000 });
  ok("save-visible-without-board", await saveBtn.isVisible());
  ok("save-disabled-empty-name", await saveBtn.isDisabled());
  ok("enter-name-hint", (await section.getByText("Enter your name to enable saving.").count()) > 0);
  ok("no-board-gate-copy-gone", (await section.getByText("Select a board to save").count()) === 0);
  await name.fill("Ava Example");
  await bg.fill("Para one.\n\nPara two.");
  await fam.fill("Fam custom");
  await simp.fill("Simp custom");
  await comm.fill("Custom direct style.");
  await saveBtn.click();
  await page.getByText(/Version 1/).first().waitFor({ timeout: 15000 });
  ok("save-v1-post-version", lastPostVersion === 0, String(lastPostVersion));
  ok("save-v1-status", (await section.getByText(/Version 1/).count()) > 0);
  ok("no-provenance-copy", (await section.getByText("Provenance").count()) === 0);
  ok("no-raw-id", !((await section.textContent()) || "").includes("prof-1"));
  await page.reload();
  await page.getByRole("heading", { name: "Profile" }).first().waitFor({ timeout: 15000 });
  await page.waitForFunction(() => { const el = document.querySelector("section[aria-label=Profile]"); return el && el.textContent.includes("Saved version 1"); }, null, { timeout: 15000 });
  ok("reload-bg-custom", (await bg.inputValue()) === "Para one.\n\nPara two.");
  ok("reload-comm-custom", (await comm.inputValue()) === "Custom direct style.");
  ok("reload-name", (await name.inputValue()) === "Ava Example");
  holdGate = [];
  await name.fill("Ava Example Jr");
  const clickP = saveBtn.click();
  while (postCount < 2) await sleep(100);
  await bg.fill("Para one.\n\nPara two. held-typing");
  holdGate.forEach((r) => r());
  holdGate = null;
  await clickP;
  await page.getByText(/newer typing was kept/).first().waitFor({ timeout: 15000 });
  ok("held-typing-preserved", (await bg.inputValue()).includes("held-typing"));
  ok("held-name-preserved", (await name.inputValue()) === "Ava Example Jr");
  ok("held-base-advanced", (await section.getByText(/Saved version 2/).count()) > 0);
  profile = Object.assign({}, profile, { version: 3, name: "Remote Other" });
  await page.goto(WEB + "/#/boards");
  await sleep(800);
  await page.goto(WEB + "/#/profile");
  await sleep(1500);
  ok("refetch-no-clobber-name", (await name.inputValue()) === "Ava Example Jr");
  ok("refetch-no-clobber-bg", (await bg.inputValue()).includes("held-typing"));
  await simp.fill("Simp custom conflict-edit");
  await saveBtn.click();
  await section.getByRole("alert").waitFor({ timeout: 15000 });
  ok("conflict-alert", ((await section.getByRole("alert").textContent()) || "").includes("Another save landed first"));
  ok("conflict-no-loss-simp", (await simp.inputValue()).includes("conflict-edit"));
  ok("conflict-no-loss-name", (await name.inputValue()) === "Ava Example Jr");
  await saveBtn.click();
  await page.getByText(/Version 4/).first().waitFor({ timeout: 15000 });
  ok("retry-uses-fresh-base", lastPostVersion === 3, String(lastPostVersion));
  ok("retry-v4", (await section.getByText(/Version 4/).count()) > 0);
  ok("retry-keeps-edit", (await simp.inputValue()).includes("conflict-edit"));
  const oldName = await name.inputValue();
  await page.evaluate(() => { localStorage.setItem("simceo-token", "token-B"); localStorage.setItem("simceo-user", "user-B"); window.dispatchEvent(new Event("simceo-auth-change")); });
  await page.waitForFunction(() => !document.body.textContent.includes("Ava Example Jr"), null, { timeout: 15000 });
  const secText = (await page.content()) || "";
  ok("identity-no-old-data", !secText.includes("Ava Example") && !secText.includes("Remote Other") && !secText.includes("held-typing"), secText.slice(0, 200));
  const nameAfter = (await name.count()) > 0 ? await name.inputValue() : "cleared-or-gated";
  ok("identity-form-cleared", nameAfter === "" || nameAfter === "cleared-or-gated", JSON.stringify(nameAfter).slice(0, 120));
  await browser.close();
  console.log("PASS " + pass + " FAIL " + fail);
  if (fail > 0) { console.log("FAILURES: " + bad.join(" | ")); process.exit(1); }
  console.log("PROFILE-SHARED-BROWSER-QA PASS");
}
main().catch((e) => { console.log("FATAL " + String(e && e.stack || e)); process.exit(1); });
