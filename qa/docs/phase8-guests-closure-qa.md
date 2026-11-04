# Phase8 Guests Closure QA Status (Muse QA-only, 75fe233 frozen)

Scope: QA only in this worktree at 75fe233. Production frozen read-only. No production source edits. Muse launched OWN memory API 15340 (SIMCEO_INSTANCE museqa75-0126-q1w2e3, USE_POSTGRES 0, META_API_BASE http://127.0.0.1:15342, qa-only key via owned launcher, WIKI_KEYRING_DIR owned .qa/muse-keyring) plus OWN scoped fake 15342 and OWN headless Edge; verified exact loopback roots (health instance, backend mode memory, auth status, fake __log array) before mutations. No human 5173/15180/5080/9333, no PG/Docker/.env/keys/realprovider/other worktrees. PRIMARY owns PG restart DB; Muse did NOT run PG scripts.

## Honest own runs (Muse executed against OWN stack)

- phase8-guests-qa.mjs PASS 47/0 (exact API gate 15340, timeouts, redacted token errors).
- phase8-extended-qa.mjs PASS 34/0 (exact API/FAKE gates, 8s timeouts, redacted errors, guest-run-not-403 excludes 500/401/503, revoked-grant relogin honestly expects 403 new-token-still-denied).
- phase8-signalr-strict-qa.cjs PASS 89/0 FINAL (exact instance/fake gates, distinct Bearers, deny-other-meeting/board/stranger/invalid via separate conns, grant-guest-m2-discuss via real route AFTER unauthorized M2 deny and BEFORE multi-join-both; camelCase sequence/content from actual POST (sequence/content) with dual-case hasMarker; immediate POST after DELETE 204; BOTH access-revoked AND closed for every affected conn; zero after with owner/unrelated controls; regrant M1+M2 plus explicit POST /join plus nonempty membership IDs; multi-guest (mA/mB/mC) and multi-meeting (mC both) with AND-closed and zero; leave-setup explicit join plus nonempty membership then live leave with AND-closed, other-grant usable via REST+hub, rejoin/REST denied, membership gone/inactive-stamped, logout/relogin no resurrection, repair no resurrection, unrelated/control preserved; timeouts/remaining/closeAll/fatalGate, redacted errors).
- phase8-guests-ui-qa.cjs PASS 49/0 FINAL on OWN headless Edge vs OWN API (exact API/BASE loopback + fake gates; public invite render; register token/user; Accept invite; Open meeting hash; composer send 201 barrier + live render + live badge; source upload/approve/download 200 exact bytes; reload message renders; settings tab exact heading Read-only guest settings for your assigned meeting. + board value; forbidden buttons absent; secretary absent; My meetings heading + exact named meeting row + Open + Leave visible + Join again absent while active; explicit Leave click; REST 403 after leave; reload no private; deep meet denied; stale purged; fresh grant 201 then Join again appears for inactive+grant then click confirms Rejoined meeting.; stranger denied link; invite2 rejoin renders; grant delete 204; held messages 403; download 403; blobs/aborts 0; live purge + live cleared; 8s req timeouts; redacted errors; screenshots under .tmp).

## Still NOT claimed (honest limitations)

- Natural 14-day expiry wallclock: sessions memory-only ~14d lifetime, no clock seam/session table; shortened-ExpiresAt wallclock + real sweep/REST proof is PRIMARY's 628 network PASS scope, under 2 proof corrections by separate App author; Muse did NOT replace with mirrored predicate and did NOT run expiry sweep here.
- PG restart persistence/non-resurrection across owned restart: PRIMARY owns restart DB (own DB 15441 primary_phase8_ prefix, nonempty run-unique manifest, no shared reset/session SQL); Muse did NOT run PG scripts.
- Commit GET handler fault with HttpRequest/503 no-data: shape rollback only via GuestsGetCommitProbe; full handler proof requires production helper (frozen).
- Runtime App75 security 2 P2 known limitations (once-only dedupe epoch+token+user, fresh-Rejoin meeting-ID-only predicate) may cause honest FAIL; report exact, do not fudge; mechanical App fix integration only after primary directs.

## QA paths touched (owned only)

- qa/phase8-signalr-strict-qa.cjs (M2 grant ordering, camelCase sequence, leave explicit join + membership, redact, gates/deadlines already present)
- qa/phase8-extended-qa.mjs (timeouts, redact, guest-run excludes 500/401/503, relogin 403)
- qa/phase8-guests-qa.mjs (exact API gate, redact)
- qa/phase8-guests-ui-qa.cjs (exact settings tab heading, exact named row, Join again absent/appears/click-confirms, timeouts, redact)
- qa/docs/phase8-guests-closure-qa.md (this file)

No production source/web edits. No other worktree writes. OWN runtime children (API/fake) to be cleaned up with exact PIDs, ports verified CLOSED; wwwroot/.qa runtime artifacts untracked, not committed.

