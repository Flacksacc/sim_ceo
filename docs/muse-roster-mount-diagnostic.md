# Roster chat mount diagnostic (Muse QA-only, OWN worktree)

Base: cd54468. Production ec2/dbb FROZEN. Main integrated QA author elsewhere; no edits to its files.
Primary symptom (from .tmp/muse-advisor-7ed-live-runtime-closure.events.jsonl): `div[data-roster-chat="RID"]` matches 178-181, bare attr SAME, nativeCount/nativeExact SAME, totalDivs ~780-791, first3 attrs SAME RID + closest section heading. Source has ONE `RosterChatPanel` mount and ONE `data-roster-chat` literal. Strict `panel.waitFor()` throws duplicate, harness catches as `panelOk=false` and reports missing. Screenshot shows real roster CharacterEditor selected, no obvious duplicate visible (below fold).

## OWN diagnostic (read-only app)

Script: `qa/muse-roster-mount-diagnostic.mjs` (Muse-authored). Headless Edge, PRIMARY 15300 + fake 15302 only. No services launch/stop. OWN new account + minimal complete quick roster (`POST /api/roster/quick` + `POST /api/roster/{id}/image/upload` 1px PNG) + token bootstrap BEFORE navigation + exact `/api/auth/me` barrier + Roster exact row select. App/roster-chat read-only (no chat POST). External/fonts abort. TOTAL 150s budget, finally closes OWN context/browser.

## Causal native evidence (OWN synthetic RID, safe)

- Blank-page inert fixture (2 divs, 1 with `data-qa-inert-blank=BLANK123`): native q=1 exact=1, PW bare=1 exact=1. Selector engine healthy.
- App inert control (`data-qa-inert-app=MUSE-INERT-CTRL-XYZ789`, non-GUID, added + REMOVED via evaluate): nativeBare=1 nativeExact=1 afterRemove=0. App selector engine healthy, no global duplication.
- `Element.prototype.getAttribute` / `Document.prototype.querySelectorAll` / `Element.prototype.matches` all `[native code]=true`. No wrapper.
- Safe synthetic RID `MUSE-SYNTH-MOUNT-ABC123`: count 0 (exact query string safe, no escaping bug).
- Real RID (OWN synthetic, shown as RID8): `pwBare/pwExact/nativeBare/nativeExact/treeWalker` all agree:
  - run1: 2/2/2/2/2, totalDivs 60, class `.roster-chat` 2, headings 2x `Chat with this advisor`
  - run4: 3/3/3/3/3, totalDivs 64 (growth with session/polls; primary 181 after 122s fits leak-per-rerender, not static JSX)
- First-3 nodes (all identical):
  - TAG `DIV`, CLASS `card roster-chat`, attrs `["class=card roster-chat","data-roster-chat=<RID>"]`
  - `Element.prototype.getAttribute.call` == `attributes.getNamedItem` == `getAttribute` == full RID, `matches(qsExact)=true`
  - outerHTML prefix (safe, RID redacted to RID8): `<div class="card roster-chat" data-roster-chat="RID8..."><h3>Chat with this advisor</h3><p>Private chat with OWN-Roster Adviser. Nothing here joins a meeting, a record, or a board.</p><div class="chatwrap"><div class="roster-chat-log" role="log" aria-`
  - ancestry: `DIV.card.roster-chat > DIV.card > DIV.roster-detail > SECTION > MAIN.main#main > DIV.maincol`
- Outer scope (followup runs): `section[My Advisor Roster]=1, div.roster-detail=1, main=1, #root=1`. Outer `div.card[data-roster-entry-id]`=2 = detail card + nested portrait-review card (same entry id, expected). Both chats share SAME parent (`sameParent=true`, `parentTag=DIV.card`, `parentKids=19`).
- Direct children of outer detail card (19 total): indices 16+17 BOTH `div.card.roster-chat attr=RID8 h=Chat with this advisor`, index 18 `div.cc-editor` (CharacterEditor). Two adjacent chat siblings + one editor from ONE `<RosterChatPanel>` JSX.

Safe conclusion: duplicate mount in DOM (siblings under same outer card), not a selector/escaping bug. Strict locator correctly throws on >1; harness mislabels duplicate as missing.

## Proposed minimal fix (no production change in this commit)

1. App: ensure exactly one `RosterChatPanel` per selected entry (remove second mount if present in served build; else fix effect leak that appends a panel per re-render/poll — suspect `selResearch` 2500ms refetch + StrictMode double-mount without cleanup). Key outer detail by entry id; keep `key={entry.id}` on panel.
2. QA: keep strict `toHaveCount(1)` assertion (do NOT weaken to `first()` until fix lands). Optionally scope locator to single detail parent first: `section[aria-label="My Advisor Roster"] div.roster-detail > div.card[data-roster-entry-id="RID"]` then `:scope > div.roster-chat`, still requiring count 1.
3. Re-run this diagnostic after fix: expect bare=exact=treeWalker=class=headings=1, outerKids single chat at index 16, editor at 17.

Portrait defect (meeting rail `p1=false count=0`) is separate product issue, left strict FAIL elsewhere; not touched here. GUI chat send stays optional until unique parent resolved.
