// human-source-format.ts - plain language copy for Sources and Wiki panels.
// Pure module with no imports and no DOM access. It projects already
// authorized data (titles, counts, excerpts) into readable labels. IDs,
// hashes, raw JSON, paths, and backend error text are never rendered.
export type MeetingRef = { id: string; title: string };

export function meetingTitle(meetings: MeetingRef[], id?: string | null): string | null {
  const want = (id ?? "").trim().toLowerCase();
  if (!want) return null;
  const hit = (meetings ?? []).find((m) => (m.id ?? "").trim().toLowerCase() === want);
  const t = (hit?.title ?? "").trim();
  return t ? t : null;
}

export function scopeLabel(scope: string, title: string | null): string {
  if ((scope ?? "").toLowerCase() === "meeting") return title ? "Meeting file - " + title : "Meeting file";
  return "Board file";
}

export function wikiScopeLabel(scope: string, title: string | null): string {
  if ((scope ?? "").toLowerCase() === "meeting") return title ? "Meeting - " + title : "Meeting";
  return "Board";
}

export function originLabel(origin: string): string {
  const o = (origin ?? "").trim().toLowerCase();
  if (o === "wiki") return "Added from Wiki connector";
  if (o === "upload") return "Added by upload";
  if (!o) return "Added manually";
  return "Added by " + o;
}

export function reviewLabel(reviewState: string, excluded: boolean): { label: string; tone: string } {
  if (excluded) return { label: "Temporarily hidden", tone: "muted" };
  const r = (reviewState ?? "").trim().toLowerCase();
  if (r === "approved") return { label: "Approved", tone: "done" };
  if (r === "rejected") return { label: "Not kept", tone: "muted" };
  return { label: "Waiting for review", tone: "open" };
}

export function indexLabel(indexState: string, isCurrent: boolean): string {
  const s = (indexState ?? "").trim().toLowerCase();
  if (s === "completed") return isCurrent ? "Ready for meetings" : "Search ready";
  if (s === "failed") return "Search unavailable for now";
  if (s === "running") return "Preparing search...";
  return "Search pending";
}

export function safeIndexHelp(): string {
  return "Search is not available for this file yet. Try reindexing, or re-upload if it keeps failing.";
}

export function currentLabel(hasCurrent: boolean, version?: number | null): string {
  if (!hasCurrent) return "No current version - an excluded file never falls back to an older one.";
  if (version != null) return "Current version is version " + version + ".";
  return "Has a current version.";
}

export type SourceContext = {
  total?: unknown; approved?: unknown; pending?: unknown; rejected?: unknown;
  excluded?: unknown; indexed?: unknown; indexFailed?: unknown; policy?: unknown;
};

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function contextSummary(ctx: unknown): string {
  if (!ctx || typeof ctx !== "object") return "Source status is currently unavailable.";
  const c = ctx as SourceContext;
  const total = num(c.total);
  const ready = num(c.approved);
  const pending = num(c.pending);
  const rejected = num(c.rejected);
  const excluded = num(c.excluded);
  const indexed = num(c.indexed);
  const failed = num(c.indexFailed);
  if (total === null && ready === null && pending === null) return "Source status is currently unavailable.";
  const parts: string[] = [];
  if (total !== null) parts.push(total === 1 ? "1 file" : total + " files");
  if (ready !== null) parts.push(ready === 1 ? "1 ready for meetings" : ready + " ready for meetings");
  if (pending !== null) parts.push(pending === 1 ? "1 waiting for review" : pending + " waiting for review");
  if (rejected !== null && rejected > 0) parts.push(rejected === 1 ? "1 not kept" : rejected + " not kept");
  if (excluded !== null && excluded > 0) parts.push(excluded === 1 ? "1 temporarily hidden" : excluded + " temporarily hidden");
  if (indexed !== null && indexed > 0) parts.push(indexed === 1 ? "1 searchable" : indexed + " searchable");
  if (failed !== null && failed > 0) parts.push(failed === 1 ? "1 needs attention" : failed + " need attention");
  const pol = typeof c.policy === "string" ? c.policy.trim().toLowerCase() : "";
  if (pol === "wikionly" || pol === "wiki-only" || pol === "wikiOnly") parts.push("Policy: Wiki connector only");
  else if (pol) parts.push("Policy: uploads allowed with blocked types");
  if (!parts.length) return "Source status is currently unavailable.";
  return parts.join(" - ") + ".";
}

function headlineFor(a: string): string {
  if (a === "upload") return "Uploaded";
  if (a === "approve") return "Approved";
  if (a === "reject") return "Not kept";
  if (a === "exclude") return "Temporarily hidden";
  if (a === "restore") return "Restored";
  if (a === "index" || a === "reindex") return "Search updated";
  if (a.indexOf("failed") >= 0) return "Search could not finish";
  if (!a) return "Updated";
  return a.charAt(0).toUpperCase() + a.slice(1);
}

export function historyText(action: string, detail: string): { headline: string; detail: string } {
  const a = (action ?? "").trim().toLowerCase();
  const d = (detail ?? "").trim();
  const scopeM = d.match(/^scope\s*=\s*(board|meeting)\s*$/i);
  if (scopeM) return { headline: headlineFor(a), detail: scopeM[1].toLowerCase() === "meeting" ? "Meeting file." : "Board file." };
  const vM = d.match(/^[vV]\s*(\d+)\s*$/);
  if (vM) return { headline: headlineFor(a), detail: "Version " + vM[1] + "." };
  const genM = d.match(/^gen\s*(\d+)\s+sections\s*(\d+)\s*$/i);
  if (genM) return { headline: headlineFor(a), detail: "Search updated - " + genM[2] + (genM[2] === "1" ? " section ready." : " sections ready.") };
  if (/migrate-version/i.test(a)) return { headline: "Version numbering repaired", detail: "Older numbering kept for history." };
  if (/policy/i.test(a)) return { headline: "Policy updated", detail: "New uploads follow the updated policy." };
  if (/fail/i.test(a)) return { headline: headlineFor(a), detail: "Search could not finish for this version." };
  const clean = d.replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}[0-9a-fA-F-]*/g, "").replace(/[{}"[\]]/g, " ").replace(/\s{2,}/g, " ").trim();
  if (!clean) return { headline: headlineFor(a), detail: "No extra detail." };
  return { headline: headlineFor(a), detail: clean.length > 160 ? clean.slice(0, 160).trimEnd() + "..." : clean };
}

export function recallKindLabel(kind: string): string {
  const k = (kind ?? "").trim().toLowerCase();
  if (k.indexOf("source") === 0 || k.indexOf("hindsight:source") === 0) return "Source";
  if (k.indexOf("record") === 0) return "Board record";
  if (k.indexOf("direction") === 0) return "Meeting direction";
  if (k.indexOf("note") === 0) return "Meeting note";
  return "Match";
}

export function recallTitle(kind: string, ref: string): string | null {
  const k = (kind ?? "").trim().toLowerCase();
  const r = (ref ?? "").trim();
  if (k.indexOf("source") === 0 || k.indexOf("hindsight:source") === 0) {
    if (!r) return null;
    if (/^[0-9a-fA-F]{8}-/.test(r)) return null;
    return r.length > 120 ? r.slice(0, 120).trimEnd() + "..." : r;
  }
  return null;
}

function extractServerMessage(raw: string): string {
  let s = (raw ?? "").trim();
  if (!s) return "";
  s = s.replace(/^(Error|Request failed|Row error)\s*:\s*/i, "");
  const m = s.match(/"error"\s*:\s*"((?:[^"\\\\]|\\\\.)*)"/);
  if (m && m[1]) {
    try {
      return JSON.parse("\"" + m[1] + "\"");
    } catch {
      return m[1];
    }
  }
  s = s.replace(/^\d{3}\s+/, "");
  s = s.replace(/[{}]/g, " ").replace(/\s{2,}/g, " ").trim();
  if (/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}/.test(s)) return "";
  if (s.length > 220) return "";
  return s;
}

function isValidationMessage(text: string): boolean {
  if (/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}/.test(text)) return false;
  if (/[{}]/.test(text)) return false;
  const t = text.toLowerCase();
  const keys = ["is required", "is blocked", "must be", "too long", "too short", "malformed", "pick a meeting", "never widen", "does not belong", "already", "denied", "not authorized", "conflict", "superseded", "newer", "immutable", "upload it again", "pending", "disabled", "enable", "credential", "allowlist", "description", "allowed use", "blocked type", "scope"];
  for (const k of keys) if (t.indexOf(k) >= 0) return true;
  return false;
}

export function safeRequestMessage(raw: string): string {
  const text = extractServerMessage(raw);
  const t = text.toLowerCase();
  if (!text) return "That did not finish. Try again. If it keeps failing, ask a board manager.";
  if (t.indexOf("identical content") >= 0) return "That file is already in the inbox with identical contents.";
  if (t.indexOf("meeting") >= 0 && t.indexOf("scope") >= 0) return "Pick a meeting for meeting uploads - uploads never widen to the board on their own.";
  if (t.indexOf("wiki-only") >= 0 || t.indexOf("wiki only") >= 0) return "This board only accepts Wiki connector material. Ordinary uploads are off.";
  if (t.indexOf("blocked") >= 0) return "That file type is blocked on this board.";
  if (t.indexOf("does not belong") >= 0) return "That meeting does not belong to this board.";
  if (t.indexOf("superseded") >= 0 || t.indexOf("successor") >= 0 || t.indexOf("newer") >= 0) return "A newer version already exists - work from the newest version. This one stays for history.";
  if (t.indexOf("denied") >= 0 || t.indexOf("not authorized") >= 0 || t.indexOf("401") >= 0 || t.indexOf("403") >= 0) return "You do not have access to do that. Ask a board manager for access.";
  if (t.indexOf("409") >= 0 || t.indexOf("conflict") >= 0) return "That change conflicts with a newer update. Refresh and try again.";
  if (isValidationMessage(text)) return text;
  return "That did not finish. Try again. If it keeps failing, ask a board manager.";
}

export function friendlySyncState(status: string, enabled: boolean): string {
  const s = (status ?? "").trim().toLowerCase();
  if (!enabled) return "Disabled";
  if (s === "succeeded") return "Synced";
  if (s === "failed") return "Last sync did not finish";
  if (s === "disabled") return "Disabled";
  return "Sync pending";
}

export function friendlyAttempt(status: string): string {
  return (status ?? "").trim().toLowerCase() === "running" ? "Sync running..." : "Idle";
}

export function safeSyncHelp(): string {
  return "Last sync did not finish. Check the address, credential, and rules, then sync again.";
}

export function safeRowHelp(path: string): string {
  if (path === "/enable") return "Could not enable this connector. Check its description, allowed use, allowlist, and credential, then try again.";
  if (path === "/sync") return "Sync did not finish. Check the address, credential, and rules, then try again.";
  if (path === "/disable") return "Could not disable this connector. Try again.";
  return "That did not finish. Check the connector settings and try again.";
}

export function relativeTime(iso?: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const diff = Date.now() - t;
  if (diff < 0) return new Date(t).toLocaleString();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return min === 1 ? "1 minute ago" : min + " minutes ago";
  const h = Math.floor(min / 60);
  if (h < 24) return h === 1 ? "1 hour ago" : h + " hours ago";
  const d = Math.floor(h / 24);
  if (d < 7) return d === 1 ? "yesterday" : d + " days ago";
  return new Date(t).toLocaleDateString() + " " + new Date(t).toLocaleTimeString();
}

export function resourceLabel(description: string, baseUrl: string, scope: string, meeting: string | null): string {
  const name = (description ?? "").trim() || (baseUrl ?? "").trim() || "Wiki connector";
  const where = (scope ?? "").toLowerCase() === "meeting" ? (meeting ? "meeting " + meeting : "meeting") : "board";
  const short = name.length > 80 ? name.slice(0, 80).trimEnd() + "..." : name;
  return short + " (" + where + ")";
}

export function actionLabel(verb: string, resource: string): string {
  return verb + " " + resource;
}
