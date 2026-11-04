# Sources and Wiki human UI (Muse workstream)

Scope: SourcesGovernance and WikiResources panels only. No App, backend,
records, usage, jobs, or guest policy changes. No other worktree writes.

What changed (bedbd06 repair)

- web/src/human-source-format.ts (pure): approval and visibility are
  independent labels (an excluded approved version stays "Approved" plus
  "Temporarily hidden"); promoted head slot and usable current version are
  labeled separately. Recall excerpts strip the server "[item-ID] record vN:"
  prefix fail-closed; titles only render for safe "FileName vN" source refs
  (paths, GUIDs, partial IDs, and backend fragments are never titles).
  Backend errors use controlled known-message mappings only: truncated JSON,
  paths, and partial IDs fall back to generic copy; the raw extension value
  is never echoed (invalid extensions get a plain-extension fix message).
  History covers wiki-import, wiki-index-repair, create, upload, policy, and
  migrate-version with parsed controlled labels; unknown actions and details
  fall back to generic copy. Action names take live-collection ordinals
  ("1 of N") so duplicates stay unique without IDs.
- web/src/sources-governance.tsx: group header shows "Usable now: version N"
  plus "Promoted: version M"; every version row shows review, visibility,
  promoted, and usable badges independently. All action buttons carry unique
  human aria-labels. Recall renders cleaned excerpts. Handlers, identity
  guards, ACLs, governance actions, and exact transport IDs unchanged.
- web/src/wiki-resources.tsx: protocol copy (pages.list/pages.single/POST
  /graphql) replaced with read-only inbox copy. Row errors keep the server
  reason through the controlled mappings (denied stays an access error,
  "disabled; enable it first" stays enable-first); unknown failures fall
  back to operation copy. Connector action names carry live ordinals.
  Handlers, guards, and transports unchanged.
- Optional fixture props on both panels (fixture) let the source-only QA
  mount the real components with authored data. Runtime behavior without
  the prop is unchanged.

QA

- web/source-wiki-human-check.tsx plus qa/source-wiki-human-qa.cjs: 136
  SSR checks (helper units plus governance/Wiki render assertions over
  visible text and accessible names). Fixtures mirror server invariants
  (usable current implies promoted head; wiki-only policy with wiki
  origins; real "[item-ID] record vN:" recall text). No services, no
  browser, no network.
- qa/source-wiki-human-mounted.mjs plus web/src/human-mount.tsx,
  web/human-mount.html, web/vite.humanmount.config.ts: 28 mounted client
  checks. Builds an ephemeral static fixture, serves it on 127.0.0.1 only,
  and drives it with headless Edge; every external origin is blocked
  fail-closed. Covers History/Sections expansion effects, recall effects,
  permission toggles, upload scope pinning, downloads, error recovery,
  sync/config copy differences, textareas, and computed accessible-name
  uniqueness. No real app services, no real HTTP/PG/Docker/keys. The mounted script runs under one overall deadline (build, launch, interactions, route cleanup) inside try/finally from startup: HTTP route cleanup plus bounded browser close plus awaited server close with listener-closed proof and failure exit; the route allowlist is exactly http://127.0.0.1:<own-port> (no localhost alias, no https, no arbitrary port).

Verification by the authoring agent

- Web typecheck plus build, SSR QA run (136 pass), and mounted QA run
  (28 pass, headless Edge, loopback fixture only). Results are in the
  commit message.
