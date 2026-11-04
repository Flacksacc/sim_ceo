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
// can never show a non-member as responding.
import type { MeetingParticipant, ParticipantActivity } from "./meeting-participants";

export interface PresenceAdvisor {
  id: string;
  boardRole: string;
  approved: boolean;
  // Already-resolved authorized portrait URL (accepted metadata only).
  // Null renders the initials fallback; never a generated/invented URL.
  portraitUrl: string | null;
}

export interface PresenceInput {
  leadName: string;
  leadRoleLabel: string;
  advisors: PresenceAdvisor[];
  // Empty list means everyone may respond (server convention).
  includedIds: string[];
  // Future authorized activity snapshot (backend lane). Optional.
  snapshot?: Map<string, ParticipantActivity>;
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

export interface PortraitImage { id: string; review?: string | null }

// Resolve a provenance selection against the advisor's OWN roster-entry
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
  const restricted = input.includedIds.length > 0;
  const included = new Set(input.includedIds);
  if (input.leadName) {
    seats.push({
      key: "lead",
      displayName: input.leadName,
      roleLabel: input.leadRoleLabel || "Board lead",
      portraitUrl: null,
      activity: "idle",
    });
  }
  for (const a of input.advisors) {
    let activity: ParticipantActivity = "idle";
    if (restricted && !included.has(a.id)) {
      activity = "excluded";
    } else if (!a.approved) {
      activity = "needs-approval";
    } else if (input.snapshot) {
      const snap = input.snapshot.get(a.id);
      if (snap && SNAPSHOT_STATES.has(snap)) activity = snap;
    }
    seats.push({
      key: a.id,
      displayName: a.boardRole || "Advisor",
      portraitUrl: a.portraitUrl,
      activity,
    });
  }
  seats.push({
    key: "secretary",
    displayName: "Secretary",
    roleLabel: "Meeting secretary",
    portraitUrl: null,
    activity: "idle",
    isSecretary: true,
  });
  return seats;
}
