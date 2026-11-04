// Muse QA-only sibling-key static check (OWN worktree, QA-only, no services).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "web", "src", "App.tsx"), "utf8");
const chat = [...src.matchAll(/<RosterChatPanel[\s\S]*?key=\{([^}]+)\}/g)].map((m) => m[1].trim());
const ed = [...src.matchAll(/<CharacterEditor[\s\S]*?key=\{([^}]+)\}/g)].map((m) => m[1].trim());
if (chat.length !== 1) { console.log("FAIL expected 1 RosterChatPanel, got " + chat.length); process.exit(1); }
if (ed.length !== 1) { console.log("FAIL expected 1 CharacterEditor, got " + ed.length); process.exit(1); }
console.log("ok single RosterChatPanel + single CharacterEditor mount");
if (chat[0] === ed[0]) { console.log("FAIL duplicate sibling keys: " + chat[0]); process.exit(1); }
for (const k of [chat[0], ed[0]]) { if (!k.includes("selRow.entry.id")) { console.log("FAIL key must stay per-advisor: " + k); process.exit(1); } }
if (!chat[0].includes("roster-chat-")) { console.log("FAIL chat key needs prefix: " + chat[0]); process.exit(1); }
if (!ed[0].includes("character-editor-")) { console.log("FAIL editor key needs prefix: " + ed[0]); process.exit(1); }
console.log("ok distinct stable keys chat=[" + chat[0] + "] editor=[" + ed[0] + "]");
