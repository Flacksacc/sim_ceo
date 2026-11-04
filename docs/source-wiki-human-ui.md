# Sources and Wiki human UI (Muse workstream)

Scope: SourcesGovernance and WikiResources panels only. No App, backend,
records, usage, jobs, or guest policy changes. No other worktree writes.

What changed

- web/src/human-source-format.ts (new, pure): meeting titles, scope and origin
  labels, review and search state labels, context summary from the known
  Context DTO allowlist, history projection for known actions and details,
  recall kind labels and safe titles, fixed safe operation copy for request,
  sync, and row errors, relative times, and connector labels.
- web/src/sources-governance.tsx: raw context JSON replaced with a human
  status summary. Meeting options and group badges resolve meeting titles.
  Review, search, origin, scope, and history labels are human. Search
  failures show fixed safe copy. Recall shows kind labels and titles or a
  generic label, never raw refs or scores. IDs stay in control wiring only.
- web/src/wiki-resources.tsx: rows show meeting titles and descriptions.
  Control names are unique human labels. Sync state, attempt, last run, and
  revision read human. Sync and row failures show fixed safe copy.
  Description is a three row paragraph field and allowed use is four rows.
  Rule patterns stay literal with plain labels. No credential echo.
- Optional fixture props on both panels (fixture) let the source-only QA
  mount the real components with authored data. Runtime behavior without
  the prop is unchanged.

QA

- web/source-wiki-human-check.tsx plus qa/source-wiki-human-qa.cjs: authored
  fixture render checks over visible text and accessible names with one
  shared positive and negative collector, plus pure helper units. IDs and
  raw payloads are injected as known fields only. No services, no browser,
  no network.
- Primary runs the owned headless loopback acceptance separately.

Verification by the authoring agent

- Web typecheck plus build, and node QA run. Results are in the commit
  message. No runtime acceptance is claimed here.
