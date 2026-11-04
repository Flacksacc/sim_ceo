// Integrated contract test for roster-only chat (no servers, no ports, fixtures only).
// Run: node qa/roster-chat-contract.mjs
// Asserts the BACKEND integration state owned by the backend profile:
// MapRosterChat wired, board direct-advisor chat retired (410), attach gated.
import { readFileSync, existsSync } from "node:fs";
import assert from "node:assert";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");
let pass = 0;
const ok = (cond, name) => { assert(cond, "FAIL: " + name); pass++; console.log("ok - " + name); };

// --- new files exist ---
ok(existsSync(new URL("server/SimCEO.Api/Work/RosterChatEndpoints.cs", root)), "RosterChatEndpoints.cs exists");
ok(existsSync(new URL("server/SimCEO.Api/Work/RosterReconcileApply.cs", root)), "RosterReconcileApply.cs exists");
ok(existsSync(new URL("web/src/roster-chat.tsx", root)), "roster-chat.tsx exists");

// --- server endpoint contract ---
const cs = read("server/SimCEO.Api/Work/RosterChatEndpoints.cs");
ok(cs.includes("/api/roster/{id:guid}/chat"), "roster chat route registered");
ok(cs.includes("CanReadRoster"), "account authorization via CanReadRoster");
ok(!cs.includes("BoardId") && !cs.toLowerCase().includes("board mission"), "no board id or board context");
ok(cs.includes("entry.ProfileJson") && cs.includes("entry.Version"), "canonical roster profile at current version");
ok(cs.includes("4000"), "message length guard");
ok(cs.includes("stored = false"), "stateless: never stored as meeting message");
ok(cs.includes("MapRosterChat"), "integrator hook MapRosterChat defined");

// --- wiring: backend integration owns this ---
const ext = read("server/SimCEO.Api/Work/Endpoints.cs");
ok(ext.includes("app.MapRosterChat();"), "MapRosterChat wired in MapExtended");
ok(ext.includes("app.MapRosterReconciliation();"), "MapRosterReconciliation wired in MapExtended");

// --- attach choke point: every board attach routes through CheckAttach ---
const ops = read("server/SimCEO.Api/Work/RosterEndpoints.cs");
ok(ops.includes("RosterIntegrity.CheckAttach"), "TryCopy gates via RosterIntegrity.CheckAttach");
ok(ops.includes("callerCanReadRoster"), "TryCopy takes caller auth booleans");
const prog = read("server/SimCEO.Api/Program.cs");
ok(prog.includes("callerCanReadRoster:"), "board attach POST passes auth booleans");

// --- board direct-advisor chat retired (roster-only direct chat) ---
ok(ops.includes("/api/boards/{bid:guid}/advisors/{aid:guid}/chat"), "retired board chat route still present (as 410)");
ok(ops.includes("statusCode: 410") || ops.includes("410"), "board chat returns 410 Gone");
ok(ops.includes("rosterChat"), "410 points to canonical roster chat route");
ok(!ops.includes("DIRECT ADVISOR CHAT"), "no board-context direct chat prompt remains");
ok(!ops.includes("board mission"), "no board-context chat prompt remains");

// --- client component contract (frontend-owned files: read-only checks) ---
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

// --- App.tsx untouched by backend profile (frontend integrator owns mount) ---
const app = read("web/src/App.tsx");
ok(!app.includes("roster-chat"), "App.tsx untouched (integrator owns mount)");

console.log("\nPASS roster-chat-contract (" + pass + " checks)");