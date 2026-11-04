# Roster chat sibling-key fix (Muse, OWN worktree)

Branch: muse/advisor-roster-chat-fix. Base: combined 2a35930 plus cherry-picks efdf32b (ece1763 portrait followup) and 63b04e8 (5330a27 QA-only diagnostic).

## Root cause (actual, not speculative)

App.tsx roster detail rendered two sibling components with identical React keys under one parent card:
RosterChatPanel keyed by entry id at old line 7782 and CharacterEditor keyed by the same entry id at old line 7795, both direct children of div.card[data-roster-entry-id].

Duplicate sibling keys make React reconciliation unstable on every parent rerender. The roster poll refetches every 2500ms, so each poll can mount one more chat node without unmounting the old one.

This fits all native evidence: one section, one detail, one main; multiple identical adjacent DIV.card.roster-chat siblings under the same detail; counts 2 then 3 growing per render and poll; totalDivs 60 then 64; primary 181 after 122s.

Native engine and inert control stayed healthy, the served bundle held one roster-chat literal, and no manual DOM insertion exists in roster-chat.tsx or App.tsx. The leak is reconciliation, not selector escaping and not a first-match workaround.
## Fix (minimal, component-specific)

Distinct stable keys that still remount per advisor: RosterChatPanel uses roster-chat- plus entry id; CharacterEditor uses character-editor- plus entry id.

Two lines changed in web/src/App.tsx. No outer-parent-only patch, no selector first-match change. Roster-only chat preserved; character, research, progress, and meeting behavior untouched; no board direct chat added.

Identity retirement is unchanged: rosterDraftKey stays identity scoped, RosterChatPanel still retires pending work on identity change, and portrait followup ece1763 stays intact with guest and sourceUI preserved.

## Evidence (OWN isolated stack 15380 plus fake 15382)
Static sibling-key check PASS: one RosterChatPanel plus one CharacterEditor, distinct prefixed keys, both per-advisor.

Web build PASS: tsc noEmit plus vite, new bundle main-DNxcsLzz.js. Server build PASS: dotnet Release 0 errors.

Diagnostic rerun on OWN fixed SPA: bare 1, exact 1, treeWalker 1, class 1, headings 1, totalDivs 56, inert healthy, single outerHTML prefix under same detail.

Interactions PASS on OWN stack: initial 1, poll 6s 1, typing 1, send echoed 1, after-send 1, switch B 1 with total 1 and no crossover, switchback 1, nav back 1, zero duplicate-key warnings.

Portrait probe PASS: existing qa/advisor-presence-portrait.cjs fully green, including empty parent early return and retire-revoke cleanup.

## Limits

OWN QA data only on OWN ports. Shared 15300 and 15302 untouched, human ports untouched, no PG, Docker, env, keys, or other worktrees touched. Owned fake, API, and browser contexts closed with bounded cleanup.

No acceptance and no deploy claims. Primary verifies and decides release. Muse is sole code, test, and script author for the changes in this branch.
