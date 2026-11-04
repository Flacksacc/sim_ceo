// human-format.ts — plain-language helpers for record review and review inbox copy.
//
// Pure module: no imports, no DOM access. It is intentionally dependency-free
// so it can be type-checked with the web app and unit-checked standalone.
// Server identifiers (item ids, hashes, watermarks, versions) are preserved in
// the data protocol; these helpers only change how they are *displayed*.

export type HumanRecordItem = {
  // Stable server-side identifier. Preserved round-trip; never shown as a title.
  key: string;
  text: string;
};

export type ItemsProblem = "empty" | "not-a-list" | "unreadable" | null;

export type ParsedRecordItems = {
  items: HumanRecordItem[];
  problem: ItemsProblem;
};

// Parse a draft items payload without throwing. Anything the server would
// reject as unreadable becomes a plain-language problem, never raw JSON.
export function parseRecordItems(json: string): ParsedRecordItems {
  let raw: unknown = null;
  try {
    raw = JSON.parse(json ?? "[]");
  } catch {
    return { items: [], problem: "unreadable" };
  }
  if (!Array.isArray(raw)) return { items: [], problem: "not-a-list" };
  if (raw.length === 0) return { items: [], problem: "empty" };
  const items: HumanRecordItem[] = [];
  for (const entry of raw) {
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      const rec = entry as Record<string, unknown>;
      const key = typeof rec.id === "string" ? rec.id : "";
      const text = typeof rec.text === "string" ? rec.text : "";
      items.push({ key, text });
    } else if (typeof entry === "string") {
      items.push({ key: "", text: entry });
    }
  }
  return { items, problem: null };
}

// Serialize back to the exact wire shape the record endpoints validate:
// an array of { id, text } objects. Keys are preserved; only display changes.
export function itemsToJson(items: HumanRecordItem[]): string {
  return JSON.stringify(items.map((it) => ({ id: it.key, text: it.text })));
}

// One decision per line, numbered for people. Reference codes stay out.
export function itemsToEditableText(items: HumanRecordItem[]): string {
  return items.map((it, i) => String(i + 1) + ". " + it.text).join("\n");
}


// Mint a well-formed id for a newly added row. The server requires every item
// to carry a non-empty unique string id; it accepts ids it has not seen
// before on revise/amend, so a clearly-prefixed client id is safe. The server
// remains the authority: anything it rejects is reported back verbatim in the
// technical details disclosure.
export function newItemKey(): string {
  const rand = Math.floor(Math.random() * 46656).toString(36);
  return "n-" + Date.now().toString(36) + "-" + rand;
}

function stripLineMarker(line: string): string {
  const m = line.match(/^\s*(?:\d+[.)]\s+|[-*]\s+|\u2022\s+)/);
  return m ? line.slice(m[0].length) : line.trim();
}

export type TextRoundTrip = {
  items: HumanRecordItem[];
  added: number;
  removed: number;
};

// Convert edited plain text back to items. Keys follow their text when a line
// still matches a previous item, so reordering or rewording nearby lines does
// not scramble identities. Brand-new lines receive fresh keys; dropped lines
// count as removed.
export function editableTextToItems(
  text: string,
  previous: HumanRecordItem[],
): TextRoundTrip {
  const byText = new Map<string, HumanRecordItem[]>();
  for (const p of previous) {
    const list = byText.get(p.text) ?? [];
    list.push(p);
    byText.set(p.text, list);
  }
  const used = new Set<HumanRecordItem>();
  const items: HumanRecordItem[] = [];
  let added = 0;
  for (const rawLine of (text ?? "").split(/\r?\n/)) {
    const line = stripLineMarker(rawLine);
    if (line === "") continue;
    const candidates = byText.get(line) ?? [];
    const reuse = candidates.find((c) => !used.has(c));
    if (reuse) {
      used.add(reuse);
      items.push({ key: reuse.key, text: line });
    } else {
      added += 1;
      items.push({ key: newItemKey(), text: line });
    }
  }
  const removed = previous.filter((p) => !used.has(p)).length;
  return { items, added, removed };
}

// Short on-demand reference, e.g. for a details disclosure or support note.
// Never used as a title.
export function shortRef(key: string): string {
  const k = key ?? "";
  return k.length <= 8 ? k : k.slice(0, 8);
}

export type RecordStatusTone = "open" | "progress" | "done" | "muted";

export type FriendlyStatus = { label: string; tone: RecordStatusTone };

const STATUS_COPY: Record<string, FriendlyStatus> = {
  open: { label: "Open for review", tone: "open" },
  "partially-approved": { label: "Partly approved", tone: "progress" },
  approved: { label: "Approved", tone: "done" },
  discarded: { label: "Not kept", tone: "muted" },
  superseded: { label: "Replaced by a newer version", tone: "muted" },
};

export function friendlyRecordStatus(status: string, decided: boolean): FriendlyStatus {
  const known = STATUS_COPY[(status ?? "").toLowerCase()];
  if (known) return known;
  if (decided) return { label: "Decided", tone: "done" };
  return { label: "In review", tone: "open" };
}

export type ItemChange = {
  kind: "added" | "removed" | "updated";
  headline: string;
  detail: string;
  key: string;
};

// Plain-language version comparison. Titles are decision text; reference
// codes appear only inside detail strings and only when needed to tell two
// similar items apart.
export function describeItemChanges(prevJson: string, curJson: string): ItemChange[] {
  const prev = parseRecordItems(prevJson).items;
  const cur = parseRecordItems(curJson).items;
  const prevByKey = new Map(prev.map((i) => [i.key === "" ? i.text : i.key, i]));
  const curByKey = new Map(cur.map((i) => [i.key === "" ? i.text : i.key, i]));
  const out: ItemChange[] = [];
  for (const [k, p] of prevByKey) {
    const c = curByKey.get(k);
    if (!c) {
      out.push({ kind: "removed", headline: "Removed", detail: p.text, key: k });
    } else if (c.text !== p.text) {
      out.push({
        kind: "updated",
        headline: "Updated",
        detail: "Was: " + p.text + " Now: " + c.text,
        key: k,
      });
    }
  }
  for (const [k, c] of curByKey) {
    if (!prevByKey.has(k)) out.push({ kind: "added", headline: "Added", detail: c.text, key: k });
  }
  return out;
}


// Translate technical review failures into actionable plain language.
// Returns an empty string when no friendly mapping applies, so callers can
// fall back to the original message inside a technical-details disclosure.
export function friendlyError(message: string): string {
  if ((message ?? "").toLowerCase().indexOf("already in progress") >= 0) {
    return "A discussion run is already in progress for this meeting; wait for it to finish.";
  }
  if ((message ?? "").toLowerCase().indexOf("account changed") >= 0) {
    return "The account changed while you were editing. Review the profile, then save again.";
  }
  const m = (message ?? "").toLowerCase();
  if (m.indexOf("revision body must be json") >= 0 || m.indexOf("must be a json array") >= 0) {
    return "That edit could not be read as a list. Use the text editor below — one decision per line — and try again.";
  }
  if (m.indexOf("must carry a non-empty string id") >= 0 || m.indexOf("duplicate draft item id") >= 0) {
    return "One row is missing its reference or two rows share one. The editor repairs this automatically — retype the row and try again.";
  }
  if (m.indexOf("must carry non-empty string text") >= 0 || m.indexOf("exceeds 8000") >= 0) {
    return "One decision is empty or too long. Keep each decision under a short paragraph and try again.";
  }
  if (m.indexOf("superseded") >= 0 || m.indexOf("successor") >= 0 || m.indexOf("current version instead") >= 0) {
    return "A newer version already exists. Open the newest version in the list and work from there — this one is kept for history.";
  }
  if (m.indexOf("already decided") >= 0 || m.indexOf("per-item decisions") >= 0) {
    return "This version is already decided. Continue on the newest open version instead of rewriting this one.";
  }
  if (m.indexOf("hash") >= 0 || m.indexOf("watermark") >= 0 || m.indexOf("review token") >= 0 || m.indexOf("stale") >= 0 || m.indexOf("guard") >= 0) {
    return "The record changed while you were reviewing it. Refresh the review and try again — your text is kept.";
  }
  if (m.indexOf("manage grant") >= 0 || m.indexOf("manage") >= 0 && m.indexOf("approv") >= 0) {
    return "Approving needs a manager role for this board. Ask a board manager to approve, or to grant you approval access.";
  }
  if (m.indexOf("explicit repair") >= 0 || m.indexOf("valid review") >= 0 || m.indexOf("no pending items") >= 0) {
    return "There is nothing ready to approve right now. Request a fresh revision, or wait for the next draft version.";
  }
  if (m.indexOf("contribute") >= 0 || m.indexOf("not authorized") >= 0 || m.indexOf("denied") >= 0) {
    return "You do not have access to change this. Ask a board manager to invite you or adjust your access.";
  }
  if (m.indexOf("unparseable") >= 0 || m.indexOf("unreadable") >= 0) {
    return "This draft could not be displayed. Request a fresh revision to continue from a clean copy.";
  }
  return "";
}

export function pluralize(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

export function countLine(count: number, one: string, many: string): string {
  return String(count) + " " + pluralize(count, one, many);
}


// Humanize a secretary packet-omission manifest. Server entries look like
// direction:<GUID>, record:<GUID>:v<N>, or source:<GUID>:<GUID>. Raw
// identifiers are never user-meaningful: render what was left out and why
// it matters, never the raw reference. Unknown shapes become a neutral
// label rather than leaking internals.
export function humanizeOmission(omitted: string[]): string {
  const parts: string[] = [];
  for (const raw of omitted) {
    const o = (raw ?? "").trim();
    if (!o) continue;
    const mv = o.match(/^record:[0-9a-fA-F-]{8,}:[vV](\d+)\s*$/);
    if (mv) { parts.push("approved record (version " + mv[1] + ")"); continue; }
    if (/^record:/i.test(o)) { parts.push("an approved record"); continue; }
    if (/^direction:/i.test(o)) { parts.push("an adopted direction"); continue; }
    if (/^source:/i.test(o)) { parts.push("a source excerpt"); continue; }
    parts.push("an item");
  }
  return parts.join("; ");
}

// Human projections for Phase 5 review.
// Wire and snapshot bytes stay server side. These helpers only change what people see.
const GUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
const HEX32_RE = /[0-9a-fA-F]{32}/g;
const NREF_RE = /\bn-[A-Za-z0-9_\-]{3,}\b/g;
function scrubIds(s: string): string {
  return (s ?? "").replace(GUID_RE, "a reference").replace(HEX32_RE, "a reference").replace(NREF_RE, "a reference");
}
const OMITTED_RE = /\[Omitted from packet[^\]]*\]/g;
export function stripOmittedManifest(body: string): string {
  const s = body ?? "";
  const cut = s.replace(OMITTED_RE, "");
  return cut.trim();
}
function omittedWarning(body: string): string {
  return OMITTED_RE.test(body ?? "") ? " Some input was omitted from the packet and was not cited." : "";
}
// Per-field allowlist for projected JSON. Only these human-meaningful fields
// render; anything else falls back to a safe neutral line (never raw JSON).
const TEXT_FIELDS = ["question", "text", "body", "content", "excerpt", "title", "background", "description", "summary", "detail", "strengths", "methods", "evidenceNeeded", "limits", "collaboration"] as const;
function shortJoin(parts: string[], cap: number): string {
  const joined = parts.filter((s) => (s ?? "").trim() !== "").join(" / ");
  if (joined.length <= cap) return joined;
  const slice = joined.slice(0, cap);
  const sp = slice.lastIndexOf(" ");
  return (sp > 40 ? slice.slice(0, sp) : slice) + " ...";
}
function valueToText(v: unknown): string {
  if (typeof v === "string") {
    const s = (v as string).trim();
    if (s.startsWith("{") || s.startsWith("[") || s.startsWith('"')) return projectNestedString(s, 220);
    return scrubIds(s);
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    const bits = v.map((e) => valueToText(e)).filter((s) => s !== "");
    return shortJoin(bits, 220);
  }
  if (v !== null && typeof v === "object") return projectObject(v as Record<string, unknown>, 160);
  return "";
}
function humanKeyLabel(k: string): string {
  const spaced = k.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[-_]+/g, " ").trim().toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
// Bounded decode of JSON string layers (max 3). Unwraps extra quoted
// string layers (double-encoded JSON) to plain JSON. Unknown or truncated
// layers fail human-safe (neutral fallback); ordinary prose stays intact.
// Malformed/unresolved JSON-like content is tracked after EVERY decode step
// and at the layer limit, not only when zero layers decoded.
function decodeUnicodeEscapesForShape(s: string): string {
  try {
    return s.replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex) => String.fromCharCode(parseInt(hex as string, 16)));
  } catch {
    return s;
  }
}
function hasJsonObjectPrefix(s: string): boolean {
  const rest = s.slice(1).trimStart();
  if (rest === "") return false;
  const c = rest[0];
  if (c === "}") return true;
  return c === '"';
}
function hasJsonArrayPrefix(s: string): boolean {
  const rest = s.slice(1).trimStart();
  if (rest === "") return false;
  const c = rest[0];
  if (c === '"' || c === "{" || c === "[" || c === "]") return true;
  if ((c >= "0" && c <= "9") || c === "-") return true;
  if (rest.startsWith("true") || rest.startsWith("false") || rest.startsWith("null")) return true;
  return false;
}
// Quoted-layer classifier: quoted protocol JSON wraps a JSON object/array
// (including \uXXXX-escaped structural quotes/braces) while ordinary prose
// such as a bare quoted label with no brace or bracket payload stays prose.
// Only brace/bracket payloads with a valid JSON prefix count as JSON-like,
// so prose is preserved and malformed protocol layers still fail safe.
function isBareJsonLike(s: string): boolean {
  const t = (s ?? "").trim();
  if (t.startsWith("{")) return hasJsonObjectPrefix(t);
  if (t.startsWith("[")) return hasJsonArrayPrefix(t);
  return false;
}
function isQuotedJsonLike(s: string): boolean {
  const t = (s ?? "").trim();
  if (t.length < 2 || t[0] !== '"') return false;
  const norm = decodeUnicodeEscapesForShape(t);
  const payload = norm.slice(1).trimStart();
  if (payload === "") return false;
  let unesc = payload;
  try {
    unesc = payload.replace(/\\(["\\/bfnrt])/g, "$1").trimStart();
  } catch {
    unesc = payload;
  }
  if (unesc === "") return false;
  const head = unesc[0];
  if (head === "{") return hasJsonObjectPrefix(unesc);
  if (head === "[") return hasJsonArrayPrefix(unesc);
  if (head === '"') {
    const inner2 = unesc.slice(1).trimStart();
    if (inner2.startsWith("{")) return hasJsonObjectPrefix(inner2);
    if (inner2.startsWith("[")) return hasJsonArrayPrefix(inner2);
    return false;
  }
  return false;
}
function unwrapQuotedLayers(s: string, maxLayers = 3): { text: string; layers: number; failedJsonLike: boolean } {
  let tt = (s ?? "").trim();
  let layers = 0;
  let failedJsonLike = false;
  while (layers < maxLayers && tt.startsWith('"')) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(tt);
    } catch {
      if (isQuotedJsonLike(tt)) failedJsonLike = true;
      break;
    }
    if (typeof decoded !== "string") break;
    tt = (decoded as string).trim();
    layers += 1;
  }
  if (!failedJsonLike && tt.startsWith('"') && isQuotedJsonLike(tt)) {
    failedJsonLike = true;
  }
  return { text: tt, layers, failedJsonLike };
}
function projectNestedString(s: string, cap: number): string {
  const uw = unwrapQuotedLayers(s, 3);
  if (uw.failedJsonLike) return "";
  const tt = uw.text;
  if (!(tt.startsWith("{") || tt.startsWith("["))) return scrubIds(tt).slice(0, cap);
  try {
    const v: unknown = JSON.parse(tt);
    const hit = projectJson(v, cap, "");
    return hit !== "" ? hit : "";
  } catch { return ""; }
}
function projectObject(o: Record<string, unknown>, cap: number): string {
  const bits: string[] = [];
  if (typeof o.question === "string" && o.question.trim() !== "") {
    const qt = (o.question as string).trim();
    const qp = (qt.startsWith("{") || qt.startsWith("[") || qt.startsWith('"')) ? projectNestedString(qt, 160) : scrubIds(qt);
    if (qp !== "") bits.push("Question: " + qp);
  }
  if (typeof o.title === "string" && (o.title as string).trim() !== "") {
    const tt2 = ((o.title as string).trim());
    const tp = (tt2.startsWith("{") || tt2.startsWith("[") || tt2.startsWith('"')) ? projectNestedString(tt2, 160) : scrubIds(tt2);
    if (tp !== "") bits.push(tp);
  }
  for (const k of TEXT_FIELDS) {
    if (k === "question" || k === "title") continue;
    const v = o[k];
    if (typeof v === "string" && v.trim() !== "") {
      const vv = (v.trim().startsWith("{") || v.trim().startsWith("[") || v.trim().startsWith('"')) ? projectNestedString(v.trim(), 160) : scrubIds(v.trim());
      if (vv === "") continue;
      const label = k === "text" || k === "body" || k === "content" || k === "excerpt" ? "" : humanKeyLabel(k) + ": ";
      bits.push(label + vv);
    } else if (Array.isArray(v) && v.length > 0) {
      const inner = v.map((e) => valueToText(e)).filter((s) => s !== "");
      if (inner.length > 0) bits.push((k === "text" ? "" : humanKeyLabel(k) + ": ") + shortJoin(inner, 160));
    }
  }
  if (bits.length > 0) return shortJoin(bits, cap);
  return "";
}
function projectJson(raw: unknown, cap: number, fallback: string): string {
  if (typeof raw === "string") {
    const t = (raw as string).trim();
    if (t === "") return fallback;
    if (t.startsWith("{") || t.startsWith("[") || t.startsWith('"')) {
      const hit = projectNestedString(t, cap);
      return hit !== "" ? hit : fallback;
    }
    const sc = scrubIds(t);
    return sc === "" ? fallback : sc.slice(0, cap);
  }
  if (Array.isArray(raw)) {
    if (raw.length === 0) return fallback;
    const bits = raw.map((e) => {
      if (e === null || e === undefined) return "";
      if (typeof e === "string") { const et = (e as string).trim(); if (et.startsWith("{") || et.startsWith("[") || et.startsWith('"')) return projectNestedString(et, 160); return scrubIds(et); }
      if (typeof e === "object" && !Array.isArray(e)) return projectObject(e as Record<string, unknown>, 160);
      return valueToText(e);
    }).filter((s) => s !== "");
    if (bits.length === 0) return fallback;
    return shortJoin(bits, cap);
  }
  if (raw !== null && typeof raw === "object") {
    const hit = projectObject(raw as Record<string, unknown>, cap);
    return hit === "" ? fallback : hit;
  }
  return fallback;
}
function extractTruncatedFields(s: string, cap: number): string {
  const bits: string[] = [];
  const re = /"(title|question|text|body|content|excerpt|background|description|summary|detail|strengths|methods|evidenceNeeded|limits|collaboration|name)"\s*:\s*"((?:[^"\\]|\\.){1,600})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s ?? "")) !== null && bits.length < 6) {
    try {
      const raw = m[2].replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
      const rt = raw.trim();
      if (rt.startsWith("{") || rt.startsWith("[") || rt.startsWith('"')) {
        const proj = projectNestedString(rt, 160);
        if (proj === "") continue;
        const label2 = m[1] === "text" || m[1] === "body" || m[1] === "content" || m[1] === "excerpt" ? "" : humanKeyLabel(m[1]) + ": ";
        bits.push(label2 + proj.slice(0, 160));
        continue;
      }
      const label = m[1] === "text" || m[1] === "body" || m[1] === "content" || m[1] === "excerpt" ? "" : humanKeyLabel(m[1]) + ": ";
      const clean = scrubIds(rt);
      if (clean !== "") bits.push(label + clean.slice(0, 160));
    } catch { /* keep scanning */ }
  }
  if (bits.length > 0) return shortJoin(bits, cap);
  return "";
}
function projectTruncated(s: string, cap: number, fallback: string): string {
  const hit = extractTruncatedFields(s, cap);
  if (hit !== "") return hit;
  return fallback;
}
function tryParseJson(s: string): { ok: boolean; value: unknown; text: string; truncated: boolean } {
  const uw = unwrapQuotedLayers(s, 3);
  if (uw.failedJsonLike) return { ok: false, value: null, text: uw.text, truncated: true };
  const t = uw.text;
  if (!isBareJsonLike(t)) return { ok: false, value: null, text: t, truncated: false };
  try { return { ok: true, value: JSON.parse(t), text: t, truncated: false }; } catch { return { ok: false, value: null, text: t, truncated: true }; }
}
export function humanNoteTitle(title: string): string {
  const t = (title ?? "").trim();
  if (t === "") return "(untitled note)";
  const parsed = tryParseJson(t);
  if (parsed.ok) {
    const hit = projectJson(parsed.value, 160, "");
    if (hit !== "") return hit;
    return "(untitled note)";
  }
  if (parsed.truncated || isBareJsonLike(parsed.text)) {
    const hit = projectTruncated(parsed.text, 160, "");
    if (hit !== "") return hit;
    return "(untitled note)";
  }
  return scrubIds(parsed.text).slice(0, 160);
}
export function humanNoteBody(body: string): string {
  const raw = body ?? "";
  const warn = omittedWarning(raw);
  const base = stripOmittedManifest(raw);
  if (base === "") return warn.trim() === "" ? "" : warn.trim();
  const parsed = tryParseJson(base);
  if (parsed.ok) {
    const hit = projectJson(parsed.value, 600, "");
    const out = (hit === "" ? "Note detail is available in context." : hit) + warn;
    return out.trim();
  }
  if (parsed.truncated || isBareJsonLike(parsed.text)) {
    const out = (projectTruncated(parsed.text, 600, "Note detail is available in context.") + warn).trim();
    return out;
  }
  return (scrubIds(parsed.text) + warn).trim();
}
export function humanEvidenceTitle(title: string, kind: string, version: number | null): string {
  const t = (title ?? "").trim();
  if (t === "") return "Supporting excerpt";
  const parsed = tryParseJson(t);
  if (parsed.ok) {
    const hit = projectJson(parsed.value, 160, "");
    if (hit !== "") return hit;
    return "Supporting excerpt";
  }
  const m = t.match(/^record v(\d+)(?:\s*\[.*\])?\s*$/i);
  if (m || kind === "record") {
    const v = m && m[1] ? m[1] : (version !== null && version !== undefined ? String(version) : "");
    return v !== "" ? "Approved record, version " + v : "Approved record";
  }
  if (parsed.truncated || isBareJsonLike(parsed.text)) {
    const hit = projectTruncated(parsed.text, 160, "");
    if (hit !== "") return hit;
    return "Supporting excerpt";
  }
  return scrubIds(parsed.text).slice(0, 160);
}
export function humanEvidenceExcerpt(excerpt: string, kind: string): string {
  const x = (excerpt ?? "").trim();
  if (x === "") return "";
  const warn = omittedWarning(x);
  const noMan = stripOmittedManifest(x);
  const parts = noMan.split(/\r?\n/).map((ln) => ln.replace(/^\s*-\s*\[[^\]]*\]\s*/, "").trim()).filter((ln) => ln !== "");
  const candidate = (parts.length > 0 ? parts.join("\n") : noMan).trim();
  if (candidate === "") return warn.trim();
  const parsed = tryParseJson(candidate);
  if (parsed.ok) {
    const fallback = kind === "dossier" ? "Advisor profile detail is available on the roster." : "Supporting detail is available in context.";
    const hit = projectJson(parsed.value, 600, "");
    const out = (hit === "" ? fallback : hit) + warn;
    return out.trim();
  }
  if (parsed.truncated || isBareJsonLike(parsed.text)) {
    const fallback = kind === "dossier" ? "Advisor profile detail is available on the roster." : "Supporting detail is available in context.";
    const out = (projectTruncated(parsed.text, 600, fallback) + warn).trim();
    return out;
  }
  return (scrubIds(parsed.text) + warn).trim();
}
export function looksLikeItemsJson(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t.startsWith("[")) return false;
  try { const v: unknown = JSON.parse(t); return Array.isArray(v); } catch { return false; }
}
export function summarizeItemsJson(jsonText: string, maxChars: number): string {
  const parsed = parseRecordItems(jsonText ?? "[]");
  if (parsed.problem !== null || parsed.items.length === 0) return "";
  const texts = parsed.items.map((it) => it.text).filter((s) => s !== "");
  if (texts.length === 0) return parsed.items.length + " decisions";
  const joined = texts.join(" / ");
  const cap = maxChars > 0 ? maxChars : 220;
  if (joined.length <= cap) return joined;
  const slice = joined.slice(0, cap);
  const sp = slice.lastIndexOf(" ");
  return (sp > 40 ? slice.slice(0, sp) : slice) + " ...";
}
export type HumanHistoryView = { headline: string; detail: string };
export function describeHistoryEntry(action: string, oldText: string, newText: string): HumanHistoryView {
  const a = (action ?? "").trim().toLowerCase();
  const nt = newText ?? "";
  const ot = oldText ?? "";
  const wholeNew = looksLikeItemsJson(nt);
  const wholeOld = looksLikeItemsJson(ot);
  if (a === "create") return { headline: "Created", detail: summarizeItemsJson(wholeNew ? nt : "[]", 220) };
  if (a === "refresh") return { headline: "Refreshed to current meeting input", detail: "" };
  if (a === "discard-remaining") return { headline: "Remaining set aside", detail: "" };
  if (a === "approve") { const s = wholeNew ? summarizeItemsJson(nt, 220) : nt; return { headline: "Approved", detail: s.length > 220 ? s.slice(0, 220) + " ..." : s }; }
  if (a === "discard") { const s = wholeNew ? summarizeItemsJson(nt !== "" ? nt : ot, 220) : (nt !== "" ? nt : ot); return { headline: "Set aside", detail: s.length > 220 ? s.slice(0, 220) + " ..." : s }; }
  if (a === "revise") { const s = wholeNew ? summarizeItemsJson(nt, 220) : nt; const o = wholeOld ? summarizeItemsJson(ot, 120) : ot; const d = o !== "" && o !== s ? "Was: " + o + " Now: " + s : s; return { headline: "Revised", detail: d.length > 240 ? d.slice(0, 240) + " ..." : d }; }
  if (a === "revise-branch" || a === "revise-child" || a === "amend-branch" || a === "amend-child") {
    if (wholeNew || wholeOld) {
      const changes = describeItemChanges(wholeOld ? ot : "[]", wholeNew ? nt : "[]");
      const label = a.indexOf("amend") >= 0 ? "Amended" : "Branched a new version";
      if (changes.length === 0) return { headline: label, detail: "" };
      const bits = changes.map((c) => c.headline + ": " + c.detail);
      const joined = bits.join(" / ");
      return { headline: label, detail: joined.length > 240 ? joined.slice(0, 240) + " ..." : joined };
    }
    return { headline: a.indexOf("amend") >= 0 ? "Amended" : "Branched a new version", detail: "" };
  }
  const fb = wholeNew ? summarizeItemsJson(nt, 220) : (nt !== "" ? nt : ot);
  const lb = a === "" ? "Updated" : a.charAt(0).toUpperCase() + a.slice(1);
  return { headline: lb, detail: fb.length > 220 ? fb.slice(0, 220) + " ..." : fb };
}
