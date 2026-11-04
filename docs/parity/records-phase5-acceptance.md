# Records Phase 5 one-document review - acceptance contract

Scope: Phase 5 gaps only. One-document review with working notes, per-item approve, revise, set aside, approve selected and approve all, evidence excerpts, recent input, version and watermark context, predecessor and successor navigation, effective line.
Human readable throughout: no raw identifiers, no JSON, no hashes, no tokens on screen. Decision ordinals label every control.

## Source changes

Backend: ReviewPayload notes now require current lifecycle state in addition to kind and provisional state. Approved evidence eligibility is untouched. All CAS, hash, token, watermark, permission, stale identity, and atomic guards are unchanged.
Frontend: the selected draft renders from one authoritative review snapshot. Displayed text and submitted guards come from the same draft. Controls require an actionable undecided non superseded review with a valid server flag. Ordinal labels name every per-item control and notification. No draft, item, hash, token, or watermark codes render in visible text, accessible names, or notifications.
History renders action specific human summaries. Whole document events project decision text instead of dumping stored JSON. Notes strip omitted packet manifests and scrub reference shaped text. Evidence titles and excerpts project recognized structures before display. Wire and snapshot bytes are preserved.
One consolidated pending surface carries per-item controls plus selected and all actions over pending items only. Selection reconciles to pending after every mutation. The whole draft editor hydrates from the authoritative snapshot while pristine and preserves owner typing. Decided, superseded, and invalid reviews render zero approval, revise, and discard controls. Read only guests see approved decision text adapted from the real guest DTO. No effective export dump and no lineage origin field use.
Version links resolve through singular authorized record detail with parent checks, so navigation works beyond the newest fifty list window. Reviewed watermark and current meeting watermark render separately with a stale indicator. Newer version wording claims existence only, never effective replacement, unless authority proves it.

## QA

API: qa/records-phase5-onedoc.mjs registers distinct accounts and uses Bearer tokens throughout, asserting each grant and setup response. It seeds readable and withheld evidence, GUID item fixtures, and full document history. It asserts exact pending sets, persisted revisions, history shape, stale 409 with refresh wording and no client wording on the wire, before and after state comparison, empty and decided and superseded guards, effective 404 before approvals and head after, mixed per-item reconcile, cross scope permissions, and a chain beyond fifty versions with singular detail resolution.
Browser: qa/browser/records-phase5-onedoc-ui.cjs authenticates its own Edge context with a Bearer token, uses ordinal control names, asserts no identifier or protocol leaks in visible text or accessible names, covers per-item revise, set aside, and approve, approve all to zero controls, reload persistence, stale holding approve with guided 409 then refresh then deliberate approve, whole draft revision rejection after decisions, branch navigation with back and forward, stranger permission context, empty draft guards, narrow dark layout, console error check, and record POST log assertions. Timeouts bound every request and a shared deadline cleans up the owned browser before exit.

## Verified by the author

Static checks only: tsc noEmit on web, vite build on web, dotnet build on server SimCEO.Api, node check on the two QA scripts and the scoped fake. No services started. No browser launched. No runtime proof claimed until primary executes the suites against primary owned isolated API, fake, and web.

Unexecuted: all runtime API and browser QA above, human port checks, deployment, and full parity acceptance. The checked in older UI expectations predate the one-document surface. The scripts above are the aligned proof for this slice, pending primary execution.
