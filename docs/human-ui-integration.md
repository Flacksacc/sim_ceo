# Human UI integration map (Muse: human feedback workstream)

Base: 3a0abff, branch muse/human-ui-feedback. New files only; no App.tsx edits
in this workstream. The central integrator owns App.tsx and applies the map
below. Overlapping surfaces are deliberately untouched: conversation and roster
creation components (owned by other workstreams), Sources panels
(sources-governance.tsx, wiki-resources.tsx), and all server code.

New reusable kit (all under web/src, all prefixed human-):

- human-format.ts — pure helpers, no imports. Tolerant item parsing, editable
  text round-trip, plain-language status and error maps, short on-demand
  references. Also compiled standalone for the isolated logic check.
- human-disclosure.tsx — HumanDisclosure, ReferenceCode, FriendlyError,
  StatusChip. Plain language first; codes and raw text one click away.
- human-record-items.tsx — RecordItemList, RecordItemEditor,
  RecordComparison, RecordVersionRow. Structured forms, never raw JSON inputs.
- human-feedback.css — narrow styles reusing existing tokens only
  (card, muted, badge, meetctl). Import once in main.tsx or App.tsx:
  import "./human-feedback.css";

Protocol rule (do not weaken): every replacement below keeps the wire shape
byte-identical. Item ids, hashes, watermarks, versions, review tokens and
guardOf(d) still travel in all calls (draft, revise, amend, approve, discard,
refresh). Only display changes. Server stays the validating authority; any
server rejection surfaces through FriendlyError with the original text kept
under technical details.

Shared snippets used below (place near other small helpers in App.tsx):

```tsx
import {
  RecordComparison,
  RecordItemEditor,
  RecordItemList,
  RecordVersionRow,
} from "./human-record-items";
import { FriendlyError, HumanDisclosure, ReferenceCode, StatusChip } from "./human-disclosure";
import { friendlyError, friendlyRecordStatus } from "./human-format";
```

```tsx
// Plain-language review alert. Drop-in for role="alert" paragraphs that
// currently render raw server or validation text.
function ReviewAlert({ message }: { message: string }) {
  const plain = friendlyError(message);
  return plain ? (
    <FriendlyError friendly={plain} technical={message} />
  ) : (
    <p role="alert">{message}</p>
  );
}
```

## Records tab (most urgent — anchor: aria-label="Records", ~line 8271)

R1 — Prepare draft: replace the raw "Items JSON" input.

Current: label "Items JSON" + input value={draftItems} + button Prepare draft
from items. People must hand-write [{id, text}] JSON.

Replacement:

```tsx
<div className="card">
  <h3>Prepare draft</h3>
  <RecordItemEditor
    draftKey="new-draft"
    initialJson={draftItems}
    onChange={(json) => setDraftItems(json)}
  />
  {canActMeeting && (
    <button onClick={prepareDraft} disabled={!parseRecordItems(draftItems).items.length}>
      Prepare draft from the list above
    </button>
  )}
</div>
```

Note: prepareDraft posts JSON.parse(draftItems) unchanged. The editor emits
the same array shape and preserves keys.

R2 — Version list rows: replace id-first rows and hash headlines.

Current: button "v{r.version} · {status}" + badge "{r.hash} @ {r.watermark}".

Replacement per row:

```tsx
<RecordVersionRow
  version={r.version}
  statusLabel={friendlyRecordStatus(r.status, r.decided).label}
  tone={friendlyRecordStatus(r.status, r.decided).tone}
  decided={r.decided}
  hash={r.hash}
  watermark={r.watermark}
  selected={r.id === recId}
  onSelect={() => setRecId(r.id)}
/>
```

R3 — Review header: move hash and watermark out of the headline.

Current: h3 "Review v{version} ({status})" + p "Hash <code>{hash}</code> ·
watermark {watermark}.

Replacement:

```tsx
<h3>Review version {recDetail.data.version}</h3>
<StatusChip
  label={friendlyRecordStatus(recDetail.data.status, recDetail.data.decided).label}
  tone={friendlyRecordStatus(recDetail.data.status, recDetail.data.decided).tone}
/>
<HumanDisclosure summary="Integrity references">
  <ReferenceCode value={recDetail.data.hash} label="Content check" />
  <span className="muted">Watermark {recDetail.data.watermark}</span>
</HumanDisclosure>
```

R4 — Decision checklist: titles become decision text, not [{id}].

Current: label.checkline per item rendering "[{it.id}] {it.text}" with
aria-label "Select item " + id, checked against selItems.

Replacement:

```tsx
<RecordItemList
  itemsJson={recDetail.data.itemsJson}
  selectable={canApproveRecord}
  selected={selItems}
  onToggle={(key, checked) =>
    setSelItems(
      checked ? [...selItems, key] : selItems.filter((x) => x !== key),
    )
  }
/>
```

Note: rows without a stored id render unselectable with an "(empty decision)"
hint instead of silently selecting "". Server requires ids on every write, so
legacy id-less rows must be fixed through revision, not approval.

R5 — Compare with another version: replace diffItems [{key}] rows.

Current: IIFE over diffItems(other.itemsJson, recDetail.data.itemsJson)
rendering "<b>{mark}</b> [{key}] {text}".

Replacement inside the same {cmpVer && (...)} guard:

```tsx
<RecordComparison prevJson={other.itemsJson} curJson={recDetail.data.itemsJson} />
```

The direction logic (older vs newer) stays as-is; describeItemChanges takes
(previous, current) in chronological order. Keep the version <select> but
render options as "Version {r.version} · {friendlyRecordStatus(...).label}".

R6 — Revised items JSON: the urgent usable editor (anchor ~line 8455).

Current: label "Revised items JSON" + raw input value={revText} with
revTextRev bump on change.

Replacement:

```tsx
<RecordItemEditor
  draftKey={recDetail.data.id + "-v" + recDetail.data.version}
  initialJson={revText}
  onChange={(json) => setRevText(json)}
/>
```

Keep reviseRec(false) and reviseRec(true) wired to the same buttons; they
parse revText exactly as today. Suggested button copy (integrator edits):

- "Request revision (new version)" stays.
- "Amend (name superseded IDs)" becomes "Amend approved record".

The revTextRev / revTextOwner ownership dance stays untouched.

R7 — Review errors: wrap raw alerts.

Current: "Review error: {reviewError.message}", "Review state invalid: " +
stateError, "explicit repair required; approval disabled",
"Unparseable items.", "Draft item text is restricted."

Replacement: render each through <ReviewAlert message={...} />. Keep the
existing canManageMeeting / canApproveRecord gating and the "Refresh review"
button. Do not remove the underlying codes from requests.

## Profile tab (anchor: aria-label="Profile", ~line 6495)

P1 — Provenance lines: six muted "Provenance: {provText(...)}" divs (name,
roleLabel, background, familiarTopics, simplerTopics, commPrefs).

Replacement per field (example: name):

```tsx
<HumanDisclosure summary="Where this came from">
  {provText(lead.data?.provenanceJson, "name") || "Not saved yet — it will appear after the first save."}
</HumanDisclosure>
```

provText output is already human ("source · date"); only the label and the
disclosure change. No protocol change: lead save payload untouched.

## People tab (anchor: aria-label="People", ~line 8480)

G1 — Demo identity card: heading "Act as (demo identity for grant checks)".

Replacement heading: "Preview access as". Add one plain line: "Type a name to
preview what that person can see. This never changes their real access."
Keep Apply identity behavior identical.

G2 — Grant rows: "{userKey} · {access}{meeting {id.slice(0, 8)}}".

Replacement: "{userKey} · {friendlyAccess} · {meetingTitle or Whole board}"
with a ReferenceCode disclosure for the meeting id when scoped. Resolve the
title from the meetings list already loaded in App; fall back to "One meeting"
if missing. Revoke buttons unchanged. friendlyAccess maps read → "Can read",
contribute → "Can contribute", manage → "Can manage".

G3 — Invitation rows: "{email} · {role} · badge {state}".

Replacement: email + friendly role + StatusChip for state (pending →
"Waiting for reply", tone open; accepted/joined → "Joined", tone done;
revoked/expired → "Closed", tone muted; unknown states render raw in a
disclosure). Revoke behavior unchanged.

## Activity tab (anchor: aria-label="Activity and Usage", ~line 8642)

A1 — Backup card ("Backup / restore"): paragraph "Hash <code>{bakHash}</code>
· {len} chars including originals and images."

Replacement: plain status "Backup ready — {len} characters saved, originals
and images included." plus HumanDisclosure summary "Backup check code" holding
the ReferenceCode for bakHash. Keep both paste inputs (functional restore
path) with plain labels: "Paste a backup snapshot" and "Paste its check code".
Restore still posts both values unchanged.

A2 — Jobs rows ("{kind} · badge {state}", "Retry (same identity)"): keep, but
map state through StatusChip wording (queued → "Waiting", running → "Working",
failed → "Needs attention" with FriendlyError for the job error, done →
"Finished"). Retry keeps identical identity semantics.

A3 — Usage and Model calls tables: keep the tables (they are live ledgers, not
debug), but rename headers to plain words: Kind → "Used for", In → "Words in"
(only if values are token counts, add "(approx. words)" to the header rather
than converting), Latency → "Wait", Search → "Web lookup". Purpose strings
render as-is; unknown purpose renders "General".

A4 — Audit table "Action / Detail" with detail sliced to 140 chars: keep for
admins, but title-attribute becomes a HumanDisclosure "Show full entry" so the
full detail is reachable without hover. No data change.

## Help tab (anchor: aria-label="Help", ~line 8909)

H1 — Command coverage list: "<b>{command}</b> → {view}: {action}".

Replacement per row: lead with the human outcome, disclose the command:

```tsx
<div className="card">
  <span>{c.action}</span>
  <HumanDisclosure summary="Show command">
    <code>{c.command}</code> in {c.view}
  </HumanDisclosure>
</div>
```

Keep the search box and keyboard-shortcut card as-is (already human). Filter
logic unchanged.

## Settings tab (anchor: aria-label="Settings", ~line 6657)

S1 — Model connection status: keep "Key: {source} {keyHint} · Model: {model}"
(admin-only, non-secret hint). Wrap test failures ("Test failed:
{lastTestError}") in <ReviewAlert message={...} />. Save/Test buttons and the
password-only key input stay exactly as-is; credentials never display.

S2 — Guest read-only settings <dl> (Board/Mission/Stage/Discussion rhythm/
Lead): already human — no change.

## Explicitly out of scope for this workstream

- Conversation surfaces (meeting thread, composer, topic tabs, roster
  creation, advisor attach flows): owned by other agents. No shared-file edits
  made or proposed here.
- SourcesGovernance and WikiResources panels and their server endpoints:
  untouched. Optional follow-up (not in this change): wrap their contentHash /
  generation / rule-id displays in HumanDisclosure + ReferenceCode. Needs the
  owning workstream, so only listed here, not implemented.
- Server roster and chat endpoints: no changes needed by this kit. If the
  integrator finds the revise/amend endpoints rejecting editor-minted "n-…"
  row references, report back instead of changing validation — the editor
  follows ValidateDraftItems (non-empty trimmed unique string id, non-empty
  text under 8000 chars).
- Old board profile copy and direct board chat design: newer user requests
  override them; preserved user data stays until reviewed reconciliation is
  approved within the already-requested task. Nothing deleted or migrated here.

## Verification performed by the authoring agent

- tsc standalone compile of human-format.ts + node fixture assertions
  (isolated, no servers, no production data).
- Full web build + focused checks (see commit message for results).
- Primary integrator still runs its own checks and the dedicated AI review;
  this kit claims no independent review.

