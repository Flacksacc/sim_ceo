// Focused contract test for roster-chat (no servers, no ports, fixtures only).
// Run: node qa/roster-chat-contract.mjs
import { readFileSync, existsSync } from "node:fs";
import assert from "node:assert";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");
let pass = 0;
const ok = (cond, name) => { assert(cond, "FAIL: " + name); pass++; console.log("ok - " + name); };

// --- new files exist ---
ok(existsSync(new URL("web/src/roster-chat.tsx", root)), "roster-chat.tsx exists");
ok(existsSync(new URL("web/src/roster-chat.css", root)), "roster-chat.css exists");
ok(existsSync(new URL("server/SimCEO.Api/Work/RosterChatEndpoints.cs", root)), "RosterChatEndpoints.cs exists");
ok(existsSync(new URL("web/src/roster-chat.INTEGRATION.md", root)), "integration doc exists");

// --- server endpoint contract ---
const cs = read("server/SimCEO.Api/Work/RosterChatEndpoints.cs");
ok(cs.includes("/api/roster/{id:guid}/chat"), "roster chat route registered");
ok(cs.includes("CanReadRoster"), "account authorization via CanReadRoster");
ok(!cs.includes("BoardId") && !cs.toLowerCase().includes("board mission"), "no board id or board context");
ok(cs.includes("entry.ProfileJson") && cs.includes("entry.Version"), "canonical roster profile at current version");
ok(cs.includes("4000"), "message length guard");
ok(cs.includes("stored = false"), "stateless: never stored as meeting message");
ok(cs.includes("MapRosterChat"), "integrator hook MapRosterChat defined");
for (const f of ["Program.cs", "Work/Endpoints.cs", "Work/RosterEndpoints.cs"]) {
  const src = read("server/SimCEO.Api/" + f);
  ok(!src.includes("MapRosterChat"), "shared server file untouched: " + f);
}

// --- client component contract ---
const tsx = read("web/src/roster-chat.tsx");
for (const [needle, name] of [
  ["msg-row", "board-style message rows"],
  ["bubble", "bubble markup"],
  ["bhead", "identity header per message"],
  ["role=\"log\"", "history log landmark"],
  ["role=\"alert\"", "error alert"],
  ["Retry", "retry affordance"],
  ["roster-chat-draft:", "identity-safe draft key"],
  ["accountId", "draft key includes account"],
  ["onKeyDown", "keyboard handling"],
  ["shiftKey", "shift+enter newline path"],
  ["localStorage", "draft persistence"],
  ["/api/roster/", "roster-scoped chat endpoint (no board id)"],
  ["history: out.slice(-10)", "bounded history sent"],
  ["epochRef", "identity/stale-response guard"],
]) ok(tsx.includes(needle), "panel: " + name);
ok(!tsx.includes("/api/boards/"), "panel never calls board endpoints");
ok(!tsx.includes("boardId"), "panel takes no board id");

// --- App.tsx untouched by this branch ---
const app = read("web/src/App.tsx");
ok(!app.includes("roster-chat"), "App.tsx untouched (integrator owns mount)");
ok(app.includes("Chat directly with an advisor"), "board chat block still present for integrator removal");

console.log("\nPASS roster-chat-contract (" + pass + " checks)");