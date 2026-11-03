# Wiki.js 2.x read-only connector protocol

Target: Wiki.js 2.x GraphQL, verified against the published v2.5.314 schema/resolver.
This project starts from Wiki.js 2.x only; no Wiki.js 3 REST claim is made here.

Pinned references:

- API docs: https://github.com/requarks/wiki-docs-v2/blob/master/dev/api.md (`POST /graphql`, Bearer token, variables supported)
- Schema: https://raw.githubusercontent.com/requarks/wiki/v2.5.314/server/graph/schemas/page.graphql
- Resolver: https://raw.githubusercontent.com/requarks/wiki/v2.5.314/server/graph/resolvers/page.js
- Upstream limitation: https://github.com/requarks/wiki/discussions/6672

Emitted operations (fixed shapes with variables; never arbitrary caller GraphQL, never mutations):

- `pages.list(limit, orderBy, orderByDirection, tags, locale)` returns PageListItem
  `{ id path locale title tags }`. List tags are plain strings. The connector
  requests `limit = 101` (100 supported maximum + 1 sentinel) ordered by PATH
  ASC and fails closed when more than 100 rows return; there is no official
  cursor/offset, so truncation is never treated as complete.
- `pages.single(id)` returns Page
  `{ id path locale title content contentType updatedAt tags { tag } }`.
  Single tags are objects with `.tag`, unlike list tags. Only `content` is
  requested (never `render`, `scriptJs`, `scriptCss`); remote scripts/styles are
  never executed or rendered. `content` additionally requires `read:source`.

Permission note: the historical v2.5.314 single resolver can also check
`manage:pages`/`delete:pages` even for reads, so a token with only read scopes
may receive 403 on `single`. The connector surfaces that as an actionable
permission error and documents this upstream limitation; it never silently
requests broader capabilities or issues mutations.

Case and rule handling (also in `WikiRules`):

- Paths are case-SENSITIVE (`/Docs/Guide` vs `/docs/guide` are distinct).
- Locale is exact case-sensitive; empty resource locale matches any page locale.
- Tags are exact case-sensitive; every required tag must be present.
- Only exact paths and `prefix/**` patterns exist; blank allowlist denies all;
  exclusions win over the allowlist.
- Ambiguous inputs fail closed: backslashes, dot-segments (`/./`, `/../`),
  double slashes, encoded separators (`%2F`, `%5C`), double-encoding (`%25`),
  null bytes, query/fragment remnants, and userinfo in URLs are rejected.

Transport: only the configured origin + `/graphql`, redirects disabled (no
token forwarding), no ambient proxy/cookies/default credentials. Bounded
streamed reads (256 KiB/page, 8 MiB aggregate), 8 s per fetch, 60 s whole sync,
concurrency 1. Errors and logs are redacted; provider bodies/tokens are never
included.

Fixed enum literals (pinned v2.5.314 SDL: PageOrderBy/PAGE_ORDER):

The list query emits orderBy: PATH and orderByDirection: ASC as enum literals,
never String variables. A String-typed orderBy variable fails schema validation
upstream; qa/wiki-sdl-validator.mjs enforces the exact emitted text and variables
against the minimal faithful SDL, with negative wrong-type/mutation controls.

Bounds (documented fixed bounds): 256 KiB per-page content, 1 MiB per-response HTTP body,
8 MiB whole-sync aggregate including catalog plus content bytes. Per-fetch 8s, whole-operation
60s starting before DNS and covering headers plus body plus parse plus staging plus commit;
cancellation checked before commit. Body stalls map to 504. Upstream Wiki 401/403 surface as
connector 502 with distinct safe codes, never app 401/403. Encoded dot-segments (%2E) and
double-encoded escapes fail closed; deliberate /** root prefix allows all paths.

Resource model: canonical required AllowedUse plus description plus explicit allowlist plus
key before enable; SetupUse explicitly off by default with UI control and wizard purpose gate;
ManualOnly (refresh off) disables scheduled sync. Attempt progress is separate from evidence
health; unchanged successful resyncs never pause meetings.

Delete and backup: deleting a connector preserves its imported source rows as detached evidence (missing-resource reads fail closed with 409 and setup extraction rejects). The canonical backup therefore records deletedWikiResourceIds explicitly; restore accepts ONLY listed known-deleted references and still rejects any other dangling graph before any clear, with exact history round-trip (IDs, CreatedAt, rules, scope, schedule) and disabled/credential-free health reset.
