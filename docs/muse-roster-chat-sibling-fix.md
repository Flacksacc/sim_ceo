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

Diagnostic rerun v2 on OWN fixed SPA asserts hard: bare 1, exact 1, treeWalker 1, class 1, headings 1, synth 0, scoped chats 1, scoped editors 1, Playwright 1 and 1, inert 1/1/0, native hooks intact; 2 completed app research polls then re-asserted identical 1s with no growth; single outerHTML prefix under same detail with editor sibling.

Interactions v2 on OWN stack: trusted launch verified before mutations; initial 1 plus 1; typed chat draft and editor link survive completed polls; send asserts real POST 200 with answer plus scoped advisor bubble, completed lead turn, idle Send, zero alerts; A/B distinct markers with late held B POST 200 isolated from A; boards shows zero chats and editors; nav back 1 plus 1; zero duplicate-key warnings. Turns are per-mount while unsent drafts persist per roster and identity, so a remounted panel starts empty with no crossover.

Portrait probe PASS: existing qa/advisor-presence-portrait.cjs fully green, including empty parent early return and retire-revoke cleanup.

## Limits

OWN QA data only on OWN exact origins http://127.0.0.1:15380 and http://127.0.0.1:15382 with credentials refused and redirects rejected. Shared 15300 and 15302 untouched, human ports untouched, no PG, Docker, env, keys, or other worktrees touched. Every fetch and body read runs under the remaining overall budget with no floor after expiry, response bodies are consumed or cancelled, browser contexts are isolated to exact origins, and each cleanup step is independently bounded with failures reported before PASS. Owned fake, API, and browser contexts closed.

No acceptance and no deploy claims. Primary verifies and decides release. Muse is sole code, test, and script author for the changes in this branch.
