// Meeting presence adapter - central frontend integration owner.
// Builds MeetingParticipant[] props for the presentational MeetingParticipants
// rail from data App already owns. Truthfulness rules (per the shared
// activity mapping in meeting-participants.INTEGRATION.md):
// approved-but-silent seats are idle, never responding; approval gates map
// to needs-approval, never to pending; excluded seats are excluded; nothing
// derives per-seat activity from a global pending flag. Until the authorized
// backend activity snapshot lands, per-seat activity is needs-approval /
// excluded / idle only. An optional snapshot map lets a future authorized
// activity feed supply real run states (queued, considering, responding,
// complete, abstained, interrupted, waiting states); the adapter still
// forces excluded and needs-approval from owned membership data so the rail
// can never show a non-member as responding. Availability gates the snapshot:
// loading/paused/unavailable snapshots never render idle-as-listening or
// retained responding; approved seats render checking/unavailable instead,
// and unselected seats never infer responding.
import type { MeetingParticipant, ParticipantActivity } from "./meeting-participants";
import type { ActivityAvailability } from "./meeting-activity";

export interface PresenceAdvisor {
  description?: string;
  id: string;
  boardRole: string;
  approved: boolean;
  // Already-resolved authorized portrait URL (accepted metadata only).
  // Null renders the initials fallback; never a generated/invented URL.
  portraitUrl: string | null;
}

// New messages identify the exact board seat. Older saved messages only carry
// its display name; resolve those only when the current board has one match.
export function messageAdvisorKey(
  message: { sender: string; advisorId?: string | null; advisorName?: string | null },
  advisors: { id: string; boardRole: string; rosterName?: string | null }[],
): string | null {
  if (message.sender !== "advisor") return null;
  const id = message.advisorId?.trim();
  if (id && id !== "00000000-0000-0000-0000-000000000000")
    return advisors.find(a => a.id.toLowerCase() === id.toLowerCase())?.id ?? null;
  const name = message.advisorName?.trim().toLowerCase();
  if (!name) return null;
  const matches = advisors.filter(a => a.boardRole.trim().toLowerCase() === name || a.rosterName?.trim().toLowerCase() === name);
  return matches.length === 1 ? matches[0].id : null;
}

export interface PresenceInput {
  leadName: string;
  leadRoleLabel: string;
  advisors: PresenceAdvisor[];
  // Empty list means everyone may respond (server convention).
  includedIds: string[];
  // Future authorized activity snapshot (backend lane). Optional.
  snapshot?: Map<string, ParticipantActivity>;
  // Explicit hook availability. Only "available" may apply the snapshot.
  availability?: ActivityAvailability;
  // Private caller-owned secretary activity (already aggregated). Optional.
  secretaryActivity?: string | null;
}

// The board-advisor record carries its selected portrait as
// ImageProvenance ("kind:image-id" plus legacy 8-char prefixes).
// Anything else is not a portrait.
export function imageIdFromProvenance(prov: string | null | undefined): string | null {
  const parts = provenanceParts(prov);
  if (parts.guid) return parts.guid;
  return null;
}

// Split provenance into a full-ID selection and/or a legacy 8-hex prefix.
// Mirrors the server resolver (RosterEndpoints.ResolveSelectedImage) without
// ever guessing: ambiguous or unresolvable selections resolve to null.
export function provenanceParts(prov: string | null | undefined): { guid: string | null; legacy8: string | null } {
  let guid: string | null = null;
  let legacy8: string | null = null;
  if (!prov) return { guid, legacy8 };
  for (const raw of prov.split(":")) {
    const tail = raw.trim();
    if (!guid && /^[0-9a-fA-F-]{36}$/.test(tail)) guid = tail;
    else if (!legacy8 && /^[0-9a-fA-F]{8}$/.test(tail)) legacy8 = tail;
  }
  return { guid, legacy8 };
}

// Acceptance mirrors the server gate (IsPortraitAccepted): accepted or
// grandfathered reviews only. Pending/rejected/revoked images never load,
// even when the selection ID is unchanged.
export function isPortraitAccepted(review: string | null | undefined): boolean {
  return review === "accepted" || review === "grandfathered";
}

// Display portrait id supplied by the authorized advisors DTO
// (server ResolveDisplayPortrait, same authority as reviewed identity).
// Only exact GUIDs load bytes; anything else renders the initials fallback.
export function normalizeDisplayImageId(id: string | null | undefined): string | null {
  if (!id) return null;
  const trimmed = id.trim();
  if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(trimmed)) return trimmed;
  return null;
}
export interface PortraitImage { id: string; review?: string | null }

// Resolve a provenance selection against the advisor OWN roster-entry
// image list (never another entry: no wrong-identity matches). A full GUID
// wins on exact same-entry match; a legacy 8-char prefix wins only on a
// single same-entry prefix match. Anything else (including ambiguity)
// resolves to null rather than guessing. The caller additionally requires
// isPortraitAccepted before loading any bytes.
export function resolveProvenanceImage(parts: { guid: string | null; legacy8: string | null }, images: PortraitImage[]): string | null {
  if (parts.guid) {
    const hit = images.find((im) => (im.id || "").toLowerCase() === parts.guid!.toLowerCase());
    if (hit && isPortraitAccepted(hit.review)) return hit.id;
    return null;
  }
  if (parts.legacy8) {
    const needle = parts.legacy8.toLowerCase();
    const hits = images.filter((im) => (im.id || "").toLowerCase().replace(/-/g, "").startsWith(needle.replace(/-/g, "")));
    if (hits.length === 1 && isPortraitAccepted(hits[0].review)) return hits[0].id;
    return null;
  }
  return null;
}

const SNAPSHOT_STATES: ReadonlySet<string> = new Set([
  "not-selected",
  "queued",
  "waiting-for-selection",
  "considering",
  "responding",
  "waiting-for-publication",
  "complete",
  "abstained",
  "waiting-for-clarification",
  "failed",
  "interrupted",
  "pending",
]);

export function buildPresence(input: PresenceInput): MeetingParticipant[] {
  const seats: MeetingParticipant[] = [];
  const avail: ActivityAvailability = (input as any)?.availability ?? "available";
  const live = avail === "available";
  const availSeat: ParticipantActivity = avail === "unavailable" ? "unavailable" : "checking";
  const restricted = input.includedIds.length > 0;
  const included = new Set(input.includedIds);
  if (input.leadName) {
    seats.push({
      key: "lead",
      displayName: input.leadName,
      roleLabel: input.leadRoleLabel || "Board lead",
      portraitUrl: null,
      activity: live ? "idle" : availSeat,
    });
  }
  for (const a of input.advisors) {
    let activity: ParticipantActivity = "idle";
    if (restricted && !included.has(a.id)) {
      activity = "excluded";

    } else if (!live) {
      activity = availSeat;
    } else if (input.snapshot) {
      const snap = input.snapshot.get(a.id);
      if (snap && SNAPSHOT_STATES.has(snap)) activity = snap;
    }
    seats.push({
      key: a.id,
      displayName: a.boardRole || "Advisor",
      roleLabel: a.description,
      portraitUrl: a.portraitUrl,
      activity,
    });
  }
  let secActivity: ParticipantActivity = live ? "idle" : availSeat;
  try {
    if (live) {
      const s = String((input as any)?.secretaryActivity ?? "");
      if (s === "responding" || s === "pending" || s === "waiting-for-clarification" || s === "complete" || s === "failed" || s === "interrupted" || s === "abstained") secActivity = s as ParticipantActivity;
      else secActivity = "idle";
    }
  } catch { secActivity = live ? "idle" : availSeat; }
  seats.push({
    key: "secretary",
    displayName: "Secretary",
    roleLabel: "Meeting secretary",
    portraitUrl: null,
    activity: secActivity,
    isSecretary: true,
  });
  return seats;
}
