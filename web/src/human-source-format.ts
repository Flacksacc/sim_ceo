// human-source-format.ts - plain language copy for Sources and Wiki panels.
// Pure module with no imports and no DOM access. It projects already
// authorized data (titles, counts, excerpts) into readable labels. IDs,
// hashes, raw JSON, paths, and backend error text are never rendered.
//
// Conventions:
// - Approval (approved / rejected / waiting) and visibility (hidden / shown)
//   are independent states with separate labels; neither collapses the other.
// - The promoted head slot and the usable current version are different: the
//   head is the newest promoted position, while the current version is the one
//   actually usable in meetings right now.
// - Backend text is never passed through by keyword. Only controlled,
//   explicitly mapped server messages produce specific copy; everything else
//   (including truncated JSON, paths, and partial IDs) falls back to generic
//   copy that names the next step.
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
  if (o === "inline") return "Added inline in a meeting";
  return "Added manually";
}

// Approval state only. Visibility is labeled separately by visibilityLabel,
// so an excluded approved version stays distinguishable from an excluded
// rejected version.
export function reviewLabel(reviewState: string, _excluded?: boolean): { label: string; tone: string } {
  const r = (reviewState ?? "").trim().toLowerCase();
  if (r === "approved") return { label: "Approved", tone: "done" };
  if (r === "rejected") return { label: "Not kept", tone: "muted" };
  return { label: "Waiting for review", tone: "open" };
}

export function visibilityLabel(excluded: boolean): { label: string; tone: string } {
  return excluded ? { label: "Temporarily hidden", tone: "muted" } : { label: "Visible", tone: "done" };
}

// Promoted head slot vs usable current version. A null return means "no badge".
export function promotedLabel(isHead: boolean): string | null {
  return isHead ? "Promoted version" : null;
}

export function usableLabel(isCurrent: boolean): string | null {
  return isCurrent ? "Usable now" : null;
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
  if (!hasCurrent) return "No usable version - hidden or unready files never fall back to an older one.";
  if (version != null) return "Usable now: version " + version + ".";
  return "Has a usable version.";
}

export function promotedGroupLabel(headVersion?: number | null): string | null {
  if (headVersion === null || headVersion === undefined) return null;
  return "Promoted: version " + headVersion + ".";
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
  if (a === "create") return "Added";
  if (a === "approve") return "Approved";
  if (a === "reject") return "Not kept";
  if (a === "exclude") return "Temporarily hidden";
  if (a === "restore") return "Restored";
  if (a === "index" || a === "reindex") return "Search updated";
  if (a === "wiki-import") return "Wiki pages added";
  if (a === "wiki-index-repair") return "Search repaired";
  if (a === "policy") return "Policy updated";
  if (a === "migrate-version") return "Version numbering repaired";
  if (a.indexOf("failed") >= 0) return "Search could not finish";
  return "Updated";
}

const GUID_ANY = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}/;

// A bare file name with no path, ID, or protocol wrapper. Null means "use
// generic copy instead of echoing the value".
function safeFileName(raw: string): string | null {
  const t = (raw ?? "").trim();
  if (!t) return null;
  if (GUID_ANY.test(t)) return null;
  if (/[{}\[\]"'#]/.test(t)) return null;
  if (/[\/\\]/.test(t)) return null;
  if (/^\s*(rev\s*\d+|v\s*\d+)\s*$/i.test(t)) return null;
  const short = t.length > 80 ? t.slice(0, 80).trimEnd() + "..." : t;
  return short || null;
}

export function historyText(action: string, detail: string): { headline: string; detail: string } {
  const a = (action ?? "").trim().toLowerCase();
  const d = (detail ?? "").trim();
  // Scope markers can arrive as "scope=board" or embedded in longer server
  // details. Match the token; never echo the raw detail.
  const scopeM = d.match(/(?:^|[\s;|,])scope\s*=\s*(board|meeting)\b/i);
  if (scopeM) {
    const where = scopeM[1].toLowerCase() === "meeting" ? "Meeting file." : "Board file.";
    if (a === "create") return { headline: "Added", detail: where };
    if (a === "upload") return { headline: "Uploaded", detail: where };
    return { headline: headlineFor(a), detail: where };
  }
  if (a === "wiki-import") {
    const m = d.match(/^rev\s*(\d+)\s*([\s\S]*)$/i);
    const name = m ? safeFileName(m[2]) : null;
    return { headline: "Wiki pages added", detail: name ? name + " synced." : "Wiki pages synced." };
  }
  if (a === "wiki-index-repair") return { headline: "Search repaired", detail: "Search index repaired." };
  if (a === "create") return { headline: "Added", detail: "Added to the inbox as pending." };
  const vM = d.match(/^[vV]\s*(\d+)\s*$/);
  if (vM) return { headline: headlineFor(a), detail: "Version " + vM[1] + "." };
  const genM = d.match(/^gen\s*(\d+)\s+sections\s*(\d+)\s*$/i);
  if (genM) return { headline: headlineFor(a), detail: "Search updated - " + genM[2] + (genM[2] === "1" ? " section ready." : " sections ready.") };
  if (a === "migrate-version") return { headline: "Version numbering repaired", detail: "Older numbering kept for history." };
  if (a === "policy") {
    const parts = d.split("|");
    const canon = (parts[0] ?? "").trim().toLowerCase();
    const blockedRaw = (parts[1] ?? "").trim();
    const blockedOk = blockedRaw.length <= 80 && /^[A-Za-z0-9,\s.\-]*$/.test(blockedRaw);
    const blockedBit = blockedOk && blockedRaw ? " Blocked: " + blockedRaw + "." : "";
    if (canon.indexOf("wiki") === 0) return { headline: "Policy updated", detail: "Only Wiki connector material is accepted." + blockedBit };
    return { headline: "Policy updated", detail: "New uploads follow the updated policy." + blockedBit };
  }
  if (a.indexOf("failed") >= 0) return { headline: headlineFor(a), detail: "Search could not finish for this version." };
  return { headline: headlineFor(a), detail: "No extra detail." };
}
export function recallKindLabel(kind: string): string {
  const k = (kind ?? "").trim().toLowerCase();
  if (k.indexOf("source") === 0 || k.indexOf("hindsight:source") === 0) return "Source";
  if (k.indexOf("record") === 0) return "Board record";
  if (k.indexOf("direction") === 0) return "Meeting direction";
  if (k.indexOf("note") === 0) return "Meeting note";
  return "Match";
}

function looksLikeIdOrPath(r: string): boolean {
  if (!r) return true;
  if (GUID_ANY.test(r)) return true;
  if (/[{}\[\]"']/.test(r)) return true;
  if (/[\/\\]/.test(r)) return true;
  if (/#/.test(r)) return true;
  if (/=/.test(r)) return true;
  if (/\b(rev|gen|scope|section|version)\s*\d*\s*=/i.test(r)) return true;
  if (/\b(rev|gen)\s*\d+\b/i.test(r)) return true;
  if (/^\s*[\d\s\-a-fA-F:#vV.]{8,}\s*$/.test(r)) return true;
  return false;
}

// Only "FileName vN" source refs are shown. Record, direction, and note refs
// are composite IDs and never have a human title.
export function recallTitle(kind: string, ref: string): string | null {
  const k = (kind ?? "").trim().toLowerCase();
  const r = (ref ?? "").trim();
  if (k.indexOf("source") === 0 || k.indexOf("hindsight:source") === 0) {
    if (!r || looksLikeIdOrPath(r)) return null;
    return r.length > 120 ? r.slice(0, 120).trimEnd() + "..." : r;
  }
  return null;
}

// Server record text arrives as "[item-ID] record vN: <excerpt>". The bracket
// prefix is an internal composite key and is never shown; only the excerpt
// after the colon is human text, scrubbed fail-closed.
export function recallExcerpt(kind: string, text: string): string {
  const t = (text ?? "").trim();
  if (!t) return "Relevant material is available in the meeting.";
  const k = (kind ?? "").trim().toLowerCase();
  let body = t;
  if (k.indexOf("record") === 0) {
    const m = t.match(/^\s*\[[^\]]*\]\s*record\s+v\d+\s*:\s*([\s\S]*)$/i);
    body = (m && m[1] ? m[1] : t).trim();
  }
  if (!body) return "Relevant material is available in the meeting.";
  if (GUID_ANY.test(body)) {
    const scrubbed = body.replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}[0-9a-fA-F-]*/g, "").replace(/\s{2,}/g, " ").trim();
    if (!scrubbed || /[{}\[\]]/.test(scrubbed)) return "Relevant material is available in the meeting.";
    body = scrubbed;
  }
  if (/[{}\[\]]/.test(body)) return "Relevant material is available in the meeting.";
  if (/(^|[\s"'(])(\/var\/|\/etc\/|[A-Za-z]:\\|https?:\/\/)/i.test(body)) return "Relevant material is available in the meeting.";
  if (/^\s*\{?\s*"error"\s*:/i.test(body)) return "Relevant material is available in the meeting.";
  return body.length > 600 ? body.slice(0, 600).trimEnd() + "..." : body;
}

const GENERIC_FAILURE = "That did not finish. Try again. If it keeps failing, ask a board manager.";

// Lenient extraction: strip the client prefix and status code, unwrap a
// well-formed {"error":"..."} envelope. Truncated envelopes (unbalanced
// braces) yield "" so fragments are never surfaced.
function looseText(raw: string): string {
  let s = (raw ?? "").trim();
  if (!s) return "";
  s = s.replace(/^(Error|Request failed|Row error)\s*:\s*/i, "");
  const m = s.match(/"error"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (m && m[1] !== undefined) {
    const opens = (s.match(/{/g) || []).length;
    const closes = (s.match(/}/g) || []).length;
    if (opens !== closes) return "";
    try {
      const parsed = JSON.parse("\"" + m[1] + "\"");
      return (parsed ?? "").trim();
    } catch {
      return "";
    }
  }
  s = s.replace(/^\d{3}\s+/, "").trim();
  if (!s || s.length > 500) return "";
  // Truncated or malformed envelopes ({, }, quotes, error keys) fail closed:
  // a fragment such as 400 {"error":"Description is required must never
  // surface as visible copy.
  if (/[{}\[\]"]/.test(s)) return "";
  return s;
}

// Controlled known-message mappings. Each returns fixed copy; raw backend
// values (extensions, paths, tokens, IDs) are never echoed. Null means
// "no known mapping - use the caller fallback".
function mappedCopy(t: string): string | null {
  if (!t) return null;
  if (t.indexOf("identical content") >= 0) return "That file is already in the inbox with identical contents.";
  if (t.indexOf("meeting") >= 0 && t.indexOf("scope") >= 0) return "Pick a meeting for meeting uploads - uploads never widen to the board on their own.";
  if (t.indexOf("not a plain extension") >= 0) return "That extension needs fixing - use a plain extension (letters, numbers, or dashes, up to 16 characters, no dot).";
  if (t.indexOf("wiki-only") >= 0 || t.indexOf("wiki only") >= 0) return "This board only accepts Wiki connector material. Ordinary uploads are off.";
  if (t.indexOf("is blocked on this board") >= 0) return "That file type is blocked on this board. Use an allowed type or ask a board manager.";
  if (t.indexOf("blocked") >= 0 && t.indexOf("policy") >= 0) return "Board policy blocks this file. Ask a board manager about the current policy.";
  if (t.indexOf("blocked type") >= 0 || (t.indexOf("blocked") >= 0 && t.indexOf("extension") >= 0)) return "That file type is blocked on this board. Use an allowed type or ask a board manager.";
  if (t.indexOf("does not belong") >= 0) return "That meeting does not belong to this board.";
  if (t.indexOf("superseded") >= 0 || t.indexOf("successor") >= 0 || t.indexOf("newer") >= 0 || t.indexOf("already exists") >= 0) return "A newer version already exists - work from the newest version. This one stays for history.";
  if (t.indexOf("denied") >= 0 || t.indexOf("not authorized") >= 0 || t.indexOf("authentication required") >= 0 || /(^|\D)(401|403)(\D|$)/.test(t)) return "You do not have access to do that. Ask a board manager for access.";
  if (t.indexOf("409") >= 0 || t.indexOf("conflict") >= 0) return "That change conflicts with a newer update. Refresh and try again.";
  if (t.indexOf("configure a credential before enabling") >= 0) return "Add a credential before enabling, then enable and sync again.";
  if (t.indexOf("set a description before enabling") >= 0 || t.indexOf("description is required") >= 0) return "Set a description before enabling, then enable again.";
  if (t.indexOf("set allowed use before enabling") >= 0 || t.indexOf("allowed use is required") >= 0) return "Set allowed use before enabling, then enable again.";
  if (t.indexOf("allowlist") >= 0 && (t.indexOf("non-empty") >= 0 || t.indexOf("denies all") >= 0 || t.indexOf("blank") >= 0)) return "Add at least one allowed path before enabling - a blank allowlist denies everything.";
  if (t.indexOf("resource is disabled") >= 0 || t.indexOf("disabled; enable it first") >= 0) return "This connector is disabled - enable it first, then sync.";
  if (t.indexOf("base url changed") >= 0) return "The address changed, so the credential was cleared. Update the credential and enable again.";
  if (t.indexOf("required configuration was removed") >= 0) return "Required settings were removed, so this connector was disabled. Restore the description, allowed use, allowed paths, and credential, then enable again.";
  if (t.indexOf("disabled by manager") >= 0) return "This connector was disabled by a manager. Cached evidence is unavailable until it is re-enabled and successfully synced.";
  if (t.indexOf("token is malformed") >= 0) return "That credential does not look complete. Check it and try again.";
  if (t.indexOf("token is too long") >= 0 || t.indexOf("token must be") >= 0) return "That credential was not accepted. Check it and try again.";
  if (t.indexOf("rule pattern") >= 0 || t.indexOf("must be an array") >= 0 || t.indexOf("blank entries") >= 0 || t.indexOf("exceed") >= 0 && t.indexOf("200") >= 0) return "One of the path or tag rules needs fixing. Use exact paths or prefix/** patterns, one per line.";
  if (t.indexOf("scope must be") >= 0 || t.indexOf("meetingid must be") >= 0 || t.indexOf("locale") >= 0 || t.indexOf("syncintervalminutes") >= 0 || t.indexOf("must be a string") >= 0 || t.indexOf("must be a boolean") >= 0 || t.indexOf("too long") >= 0 || t.indexOf("too short") >= 0 || t.indexOf("malformed") >= 0) return "One of the fields needs fixing. Check the highlighted requirements and try again.";
  if (t.indexOf("board policy forbids") >= 0) return "Board policy blocks this file. Ask a board manager about the current policy.";
  if (t.indexOf("board not found") >= 0 || t.indexOf("meeting not found") >= 0 || t.indexOf("source not found") >= 0) return "That item is no longer available. Refresh and try again.";
  return null;
}

export function genericFailure(): string {
  return GENERIC_FAILURE;
}

export function safeRequestMessage(raw: string): string {
  const text = looseText(raw);
  if (!text) return GENERIC_FAILURE;
  const known = mappedCopy(text.toLowerCase());
  return known ?? GENERIC_FAILURE;
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

// Row errors keep the actionable server reason through the same controlled
// mappings; only unknown failures fall back to operation-only copy.
export function safeRowHelp(path: string, raw?: string): string {
  const text = looseText(raw ?? "");
  const known = text ? mappedCopy(text.toLowerCase()) : null;
  if (known) return known;
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

// The position/total suffix ("2 of 3") makes every action name unique even
// when descriptions are duplicated or share a long prefix. It uses the live
// collection position, never an ID.
export function resourceLabel(description: string, baseUrl: string, scope: string, meeting: string | null, position?: number | null, total?: number | null): string {
  const name = (description ?? "").trim() || (baseUrl ?? "").trim() || "Wiki connector";
  const where = (scope ?? "").toLowerCase() === "meeting" ? (meeting ? "meeting " + meeting : "meeting") : "board";
  const short = name.length > 80 ? name.slice(0, 80).trimEnd() + "..." : name;
  let label = short + " (" + where + ")";
  if (typeof position === "number" && typeof total === "number" && total > 0 && position > 0) label += " - " + position + " of " + total;
  return label;
}

export function sourceActionLabel(verb: string, fileName: string, version?: number | null, position?: number | null, total?: number | null): string {
  const name = (fileName ?? "").trim() || "File";
  const short = name.length > 60 ? name.slice(0, 60).trimEnd() + "..." : name;
  let label = verb + " " + short;
  if (typeof version === "number") label += " version " + version;
  if (typeof position === "number" && typeof total === "number" && total > 0 && position > 0) label += " (" + position + " of " + total + ")";
  return label;
}

export function actionLabel(verb: string, resource: string): string {
  return verb + " " + resource;
}
