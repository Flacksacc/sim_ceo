# Records Phase 5 QA closure — Muse isolated proof (QA and scripts only)

Scope: this Muse authored ONLY qa/records-phase5-launch.mjs, qa/records-phase5-onedoc.mjs, qa/browser/records-phase5-onedoc-ui.cjs, and this doc.
Source (web/, server/) is FROZEN at 181140d. Formatter finding 4 (human-format quoted-content classifier) is assigned to a separate Muse on an isolated branch and is explicitly OUTSIDE this scope: no web/ or server/ file was edited here, and the known formatter bug is NOT waived.

## Primary evidence correction

The independent review mislabels the 222 HTTP / 198 browser logs as author evidence. Corrected: .tmp/primary-records-181140d-runtime.log is INDEPENDENT fresh owned green runtime (fresh staging publish + keyring, memory-only API 15320, scoped fake 15322, run-unique instance, ports verified closed), and it is preserved as the meaningful baseline below.
## Finding closure map (QA-owned findings 1, 2, 3, 5, 6, 7)

### Finding 1 — exact configured origins, no localhost or https variants

Launcher, HTTP suite, and browser preflight now require protocol http and hostname exactly 127.0.0.1 (localhost refused everywhere, https refused everywhere).
Browser routeGuard compares complete request origins (exact API origin http://127.0.0.1:15320 and exact fake origin http://127.0.0.1:15322, scheme included) instead of host:port pairs.
https://localhost, http://localhost, https://127.0.0.1, IPv6, userinfo, wss, non-owned ws, and 3xx redirects are all aborted; data:/blob: still pass. Live-update ws is permitted only to the exact owned host (ws://127.0.0.1:15320|15322, no localhost variant) so the owned SignalR transport is not self-broken.
The redirect repair (maxRedirects 0 + abort 3xx) is retained and now applies only inside the exact-origin gate.
### Finding 2 — sanitized host configuration, no DOTNET_ wildcard

childEnv no longer admits the DOTNET_ prefix. Only three benign CLI flags pass by exact name; every other DOTNET_ key is deleted post-filter.
DOTNET_CONTENTROOT is pinned to the owned fresh publish dir (proven by the API Content root path log line), and absence of STARTUP_HOOKS-style keys plus the surviving allowlist is printed as sanitized-host proof per run.
### Finding 3 — lifecycle: no outer kill before teardown, spawn tracking, TOTAL clamp

Outer browser timeout is 960s against the 900s in-browser watchdog plus bounded cleanup and final-exit guards, so the launcher can no longer kill the runner before teardown.
fake/api spawn errors are consumed via error listeners (no silent launcher death), owned PIDs are logged, and the browser logs its owned Edge PID with late-acquisition handling.
Build, HTTP, browser, and final-success phases are each clamped to the remaining 22-minute TOTAL budget, and a final TOTAL guard runs after successful browser completion, so a suite starting near minute 22 can no longer finish late with exit 0.
IPv6 loopback listeners on both owned ports are refused at preflight and verified closed at cleanup.
### Finding 5 — Reload acceptance is now App-level proof

Reload button visibility and enabled state are asserted on the live App after the stale-submit conflict surfaces reviewError (the gating predicate hides it while pristine or while the review query is in error, which the suite observes rather than overrides).
A route-level hold gates the App review GET: the click is proven issued, NEW typing during the hold wins after settlement, and a follow-up Reload shows authority with post-settlement NEW typing preserved.
App-GET 403 and App-GET transport abort (not unrelated Node calls) are stubbed for the next Reload: whole text, whole detail, child edit, unknown metadata/refs, canonical state, and mounted editor are all proven preserved with zero state write.
Observed App predicate: a failed review refetch puts the review query in error, which hides query-gated controls until remount; that is asserted as-is (no button invented), and recovery is proven by remount showing latest authority before the same-record submit.
After successful Reload the SAME record and editor submit with live guards: successor, fresh text, retained detail/refs, and seeded unknown metadata/refs are asserted. No fresh-fixture bypass remains.
Manager nonempty pending reviews with forged stateValid false and with missing validity both show zero approval, revise, discard, and selection controls (guest omission and empty-draft checks retained).
Selected approval is clicked through real checkboxes and both items approve with controls clearing.
The effective/historical/pending-child matrix is complete for manager and guest: approved ancestor with pending child stays current, approved v2 shows historical plus current-effective with versions, partial heads stay current, and obsolete guest v1 stays historical.
Auth setup is fatal-first and the browser proves its own mounted session (in-page storage plus in-page /api/auth/me) before GUI work.
### Finding 6 — meaningful authorized spending policy before Secretary

HTTP asserts the authorized policy before Secretary: allowed mode value, enforced derived from mode plus cap, numeric known spend, derived overCap, and stranger 403 as access denial rather than cap enforcement.
Browser proves its owner and stranger 403s carry access-denial wording (admin scope), never cap enforcement; authorized values stay covered by the HTTP pre-Secretary proof on the same owned instance.
Secretary then proceeds on the owned fake with run-correlated routing proof, showing the policy does not block the authorized flow.
### Finding 7 — exact expected-error correlation, no blanket suppression

An expected-error registry ties every records 403/409 allowance to the specific request path plus the deliberate step that causes it; entries are consumed on match.
Handshake and transport noise is no longer blanket-allowed: it passes only within 20s of a same-context navigation (teardown races) or within 60s of an owned ws upgrade the guard passed, and record-path allowances still require a registered expectation.
Stranger and reader 403 page-load failures are excused only when a URL in the combined message resolves to an exact owned origin (no-grant contexts fail every owned fetch by construction); 409/500 and non-owned failures still fail.
Deliberate route-abort transport failures stamp the guard time, so only initiator-located ERR_ABORTED/ERR_FAILED inside 15s of that deliberate abort is excused.
Blanket records-path, stranger/reader, and handshake suppression is removed. Collectors still cover main, stranger, and reader contexts.
## Owned runtime evidence (this closure)

Fresh owned green runtime via qa/records-phase5-launch.mjs, instance muse-r597-mw208ogx-8e81, source sha 181140da (frozen):
- dotnet build PASS, vite build PASS, node syntax checks PASS on all QA scripts and suites.
- HTTP records5-onedoc: pass 226 fail 0 (baseline 222 preserved in full; plus 6 authorized spending derivations replacing 2 presence checks).
- Browser records5-onedoc-ui: pass 234 fail 0 (baseline 198 preserved in full; plus 36 new App-level proofs: held GET, App 403/abort, same-record submit with unknown refs, invalid manager validity, selected approval, pending-child and guest-historical matrix, mounted auth, spending denial wording).
- TOTAL guard passed at final success (elapsedMs 70886, inside the 22-minute budget); ports 15320 and 15322 IPv4 and IPv6 verified closed; launcher exit 0.
- Full console log retained at this worktree under .tmp/muse-rerunA-console.log; no PG, Docker, .env, real providers, or human ports touched.
Allowed surface only: owned 15320/22 plus headless Edge, controlled fresh build, memory backend, dummy key. No PG, Docker, .env, real providers, human ports (5080/5173/9333/15180), other ports, repo roots, or global kills.

## Limits (unchanged)

PG persistence and external providers remain unexecuted and unclaimed. Public DTO equality is not internal persistence proof (separate Atomic probes).
Formatter finding 4 is a known production bug explicitly outside this scope; it is documented, not waived.
