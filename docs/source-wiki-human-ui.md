# Sources and Wiki human UI (Muse workstream)
Scope: SourcesGovernance and WikiResources panels only. No App, backend,
records, usage, jobs, or guest policy changes. No other worktree writes.
What changed (production recovery and labeling)
- web/src/human-source-format.ts (pure): approval and visibility are
  independent labels (an excluded approved version stays "Approved" plus
  "Temporarily hidden"); promoted head slot and usable current version are
  labeled separately. Recall excerpts strip the server "[item-ID] record vN:"
  prefix fail-closed; titles only render for safe "FileName vN" source refs
  (paths, GUIDs, partial IDs, and backend fragments are never titles).
  Backend errors use controlled known-message mappings only: truncated JSON,
  paths, and partial IDs fall back to generic copy; the raw extension value
  is never echoed (invalid extensions get a plain-extension fix message).
  HTTP status is preserved separately from the body: 401/403 keep access
  copy and 409 keeps conflict copy even when the body is a strict JSON
  envelope or a known plain body. The exact actual permission text
  "Access revoked or not granted for this scope." maps to fixed access copy
  without echoing raw text. Strict JSON quoted strings (for example the
  actual BadRequest("Token is malformed.") body '"Token is malformed."')
  are unwrapped with JSON.parse and then only controlled known credential
  messages produce guidance; arbitrary quoted values, path fragments, and
  truncated strings stay generic. History covers wiki-import,
  wiki-index-repair, create, upload, policy, and migrate-version with parsed
  controlled labels; unknown actions and details fall back to generic copy.
  Source action names include human scope plus meeting title and a globally
  unique family position (family F of FT plus version P of T) derived from
  the live groups array, so board and meeting families with the same file
  name and version stay unique without GUIDs. Connector action names carry
  live collection ordinals.
- web/src/sources-governance.tsx: group header shows "Usable now: version N"
  plus "Promoted: version M"; every version row shows review, visibility,
  promoted, and usable badges independently. All action buttons carry unique
  human aria-labels built from the live groups array (scope plus meeting
  title plus family ordinal). Recall renders cleaned excerpts. Handlers,
  identity guards, ACLs, governance actions, and exact transport IDs
  unchanged.
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
- web/source-wiki-human-check.tsx plus qa/source-wiki-human-qa.cjs: SSR
  checks (helper units plus governance/Wiki render assertions over visible
  text and DOM aria-label attributes). Fixtures mirror server invariants
  (usable current implies promoted head; wiki-only policy with wiki
  origins; real "[item-ID] record vN:" recall text; usable pages only when
  configRevision equals lastSuccessfulRevision). Includes duplicate-family
  render checks for same filename and version across board and meeting
  scopes. No services, no browser, no network.
- qa/source-wiki-human-mounted.mjs plus web/src/human-mount.tsx,
  web/human-mount.html, web/vite.humanmount.config.ts: mounted client
  checks. Builds an ephemeral static fixture, serves it on 127.0.0.1 only,
  and drives it with headless Edge; every external origin is blocked
  fail-closed. Covers History/Sections expansion effects, recall effects,
  permission toggles, upload scope pinning, downloads, error recovery
  (including the actual permission text and quoted credential bodies),
  sync/config copy differences, textareas, duplicate-family uniqueness with
  transport ID checks, Wiki row-alert scoping, and DOM aria-label
  uniqueness verified through Playwright getByRole name resolution (not a
  native screenreader claim). The usable Wiki fixture keeps configRevision
  equal to lastSuccessfulRevision. No real app services, no real
  HTTP/PG/Docker/keys. The mounted script runs under one overall deadline
  (build, launch, interactions, route cleanup) inside try/finally from
  startup: HTTP route cleanup plus bounded browser close plus awaited
  server close with listener-closed proof and failure exit; the route
  allowlist is exactly http://127.0.0.1:<own-port> (no localhost alias, no
  https, no arbitrary port).
Verification by the authoring agent
- Web typecheck plus build, SSR QA run, and mounted QA run (headless Edge,
  loopback fixture only). Results are in the commit message.
