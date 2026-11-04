# OWN local stack hardening (Muse sole-QA author, helper-only)

Owns EXACTLY `qa/own-local-stack.mjs` + this doc. Parallel test author owns the
monolith (`qa/advisor-integrated-qa.mjs`) and contract original root; this round
Muse performs CODE ONLY on the helper and MUST NOT edit those files.

Base: `2adbcde`. Product (`web/`, `server/`) frozen at `562` (`5623fe1` via
`ef20f5d`); Wiki `509e6a6` + spend-default `a51fcc2` are behavior-preserving for
advisor paths. Primary independently ran the fresh combined `ff7`
(562+Wiki509+spend-a51) integrated `210/0` in `147070ms`
(`.tmp/primary-advisor-ff7-integrated.log`), native PG `37/0` earlier, and real
provider `62/62` now passing
(`.tmp/primary-advisor-real-15190-v2-result.json`); no additional production
defect confirmed here.

Parent full review: `.tmp/advisor-2adbcde-full-review.txt`, findings 1,3,4,5 +
helper 6. This helper closes the HELPER side precisely; monolith-side gaps
(findings 6-11, monolith parts of 5) remain with the parallel author.

## Guarantees closed here

### 1. Process identity (tri-state, expected absolute exe+args)

- `procIdentity(pid)` returns `{status, pid, creation, cmd, exe}` with
  `status: alive | absent | unavailable`:
  - `absent`: CIM query succeeded with empty/`null` result (provably dead).
  - `unavailable`: spawn error/timeout/signal, non-zero CIM exit with output,
    JSON parse failure, or incomplete identity (empty CreationDate/cmd/exe).
    NEVER treated as dead; recovery metadata retained, never deleted.
  - `alive`: all three fields non-empty and PID matches.
- Initial capture MUST validate expected absolute exe+args:
  - API: `ExecutablePath` absolute, basename `dotnet(.exe)`, `CommandLine`
    contains absolute `OWN/publish/SimCEO.Api.dll`.
  - Fake: `ExecutablePath` absolute, basename `node(.exe)`, `CommandLine`
    contains absolute `REPO/qa/advisor-integrated-fake.mjs`.
  - Mismatch or `unavailable` immediately after spawn kills via fresh cleanup
    and exits 2; identity written to `FAILFILE` when unavailable.
- Later comparisons (`identityMatches`) require ALL of
  `CreationDate` + `CommandLine` + `ExecutablePath` (case-insensitive exe
  equality on Windows) plus kind basename. `tasklist` fallback is diagnostic
  only, never ownership. PID reuse is refused, never killed. Old PIDs
  `73804`/`73540` verified dead (`absent`) via this path; stale file removed
  without kill.

### 3. Controlled env + published configuration

- `apiEnv()` allowlist: sets `ASPNETCORE_URLS` (127.0.0.1:15396), `META_API_BASE`
  (127.0.0.1:15398), `META_API_KEY=qa-only-15396-never-real`, `SIMCEO_INSTANCE`,
  `WIKI_KEYRING_DIR`, `ASPNETCORE_ENVIRONMENT=Production`, `USE_POSTGRES=0`;
  purges (case-insensitive/prefix) `CONNECTIONSTRINGS__*`, any `KESTREL`
  substring, `ENDPOINTS__*`, `POSTGRES*/PG*/NPGSQL*`, `ASPNETCORE_HTTPS*`,
  `DOTNET_URLS*`/`DOTNET_HTTPS*`, `HTTPS_*`, `DOTNET_CONTENTROOT*`,
  `*STARTUP_HOOKS*`, `ASPNETCORE_CONTENTROOT*`, plus `DOTNET_*`/`ASPNETCORE_*`
  with `URL/HTTPS/KESTREL/ENDPOINT/CONTENTROOT/STARTUP`. `assertControlledEnv`
  re-checks QA key, `USE_POSTGRES=0`, no surviving `KESTREL`/contentroot/startup.
- Published config: `verifyPublishedEndpointConfigStrict()` scans ONLY
  `OWN/publish/appsettings*.json` (no external roots; content root is `API_DIR`
  via `cwd`, CONTENTROOT env purged). Any `Kestrel` key at any depth, any case,
  or flattened `__`/`:` segment equal to `kestrel` (ASP.NET case-insensitive
  semantics) refuses with exit 2. Malformed JSON refuses. Values containing
  "kestrel" as data do NOT refuse; only keys.
- No secrets/`.env` reads: helper never reads `.env` files or logs values.
  `existenceCheckUnapprovedBeforeBuild()` lists unapproved NAMES only.

### 4. Supervision + fresh cleanup deadlines

- Handlers installed IMMEDIATELY after each `spawn` (no gap), unconditional
  `try/finally` around boot, active FULL controller lifetime (no
  `Date.now() < startDeadline` gate on sibling handling).
- Sibling `error`/`exit` at ANY time triggers full cleanup + exit 2 (no orphan).
- Boot expiry, sibling error/exit, any throw, and `SIGINT`/`SIGTERM` all use a
  SEPARATE fresh deadline (`FRESH_CLEANUP_MS=15000`), never the expired start
  budget. `cleanupFresh(reason, pids)` kills owned, verifies `absent` via
  tri-state (unavailable counts as failure), checks both TCP ports closed,
  writes `pids.failed.json` on failure. Cleanup result controls exit code
  (non-zero on incomplete) and retains failure metadata with verified exit.
- Budgets: `START_BUDGET_MS=120000`, `STOP_BUDGET_MS=25000`,
  `BUILD_BUDGET_MS=600000`. Absolute deadlines, no floors past deadline;
  `getJson` caps to remaining budget; `waitBoot` honors `startDeadline`.

### 5. Build-time provenance (publish/build subcommand)

- `node qa/own-local-stack.mjs build` (alias `publish`): fresh controlled
  `npm --prefix web run build` + `dotnet publish ... -o OWN/publish`, stages
  `web/dist` -> `OWN/publish/wwwroot` (fresh delete+copy), verifies endpoint
  config, writes `OWN/build-manifest.json` (`version:1`, `success:true/false`).
  All spawns bounded array args + `windowsHide:true`. Logs to `OWN/logs/`.
- `build-manifest.json` records: `commit` (HEAD), `dirty` + `dirtyFiles`,
  `nodeVersion`/`dotnetVersion`/`builderPid`/`at`, `inputs` (sha256 of
  `SimCEO.Api.csproj`, `Program.cs`, `Data/Domain/Hubs/Work/*.cs`,
  `web/package.json`, `vite.config.ts`, `index.html`,
  `boardroom-template.html`, `web/src/**/*.{ts,tsx,js,jsx,css}`),
  `outputs` (`dllSha/dllSize`, `depsSha`, `rcSha`, `wwwrootSha` (index),
  `js`/`css` maps for ALL served assets, `appsettings` hashes),
  `qaSha/fakeSha/helperSha`. Failure writes `success:false` + `error`.
- `start` REQUIRES successful manifest: loads `build-manifest.json`, rejects
  missing/unsuccessful/invalid-commit, re-hashes CURRENT DLL/wwwroot/JS/CSS +
  QA/fake/helper (never trusts old DLL hash), rejects dirty-since-clean or
  HEAD-moved-since-build, attaches fresh `startHead`. Records per-run
  `nonce` + `controllerPid` + exact `apiIdent`/`fakeIdent` (creation/cmd/exe)
  into `pids.json`, `run.json`, `manifest.json`.

## QA consumer contract (for monolith; DO NOT edit monolith this round)

`qa/advisor-integrated-qa.mjs` (parallel author) SHOULD consume the exact
manifest before the first `POST /auth/register`:

- Read `OWN/manifest.json` (run) + `OWN/build-manifest.json` (build):
  `nonce`, `controllerPid`, `apiPid/fakePid`, `apiIdent/fakeIdent`
  (creation/cmd/exe), `commit`/`startHead`, `instance`,
  `dllSha/wwwrootSha/qaSha/fakeSha/helperSha`, plus `outputs.js/css` maps.
- Required monolith checks (documented here, implemented there, NOT here):
  verify `instance==qa-author-15396`, `/ready.store==inmemory`, fake `__log`
  fresh-empty, recorded `qaSha/fakeSha` match current files with commit-string
  length semantics preserved, recorded DLL/assets freshness tied to running API
  (build commit vs `startHead`), `nonce` bound to run, child identities logged
  in `ok()` output. Monolith findings 5 (provenance binding), 6 (deadlines),
  7 (FULL DTO/nulls), 8 (independent detector positives), 10 (overlap), 11
  (research transfer/evidence/prefs/prereq stops) remain with that author.
- Successful `ok()` output SHOULD include the supplied identity details
  (nonce/controller/child creation/cmd/exe/dll shas) so provenance is auditable.

## Ports, isolation, and non-goals

- ONLY `127.0.0.1:15396` (API) + `127.0.0.1:15398` (fake). Refuses occupied
  ports; never touches PG/Docker/real provider/`.env`/human `5173`/`9333`/
  `15180`/shared ports/global kills/other roots. `windowsHide:true` everywhere;
  bounded args, no shell injection (`powershell.exe`/`tasklist.exe`/`git`/
  `node`/`dotnet`/`npm` via array args, PID integers only).
- Keyring: fresh `OWN/keyring` (dummy QA keyring). No real keyring.
- Old PIDs `73804`/`73540`: primary-verified dead; helper verified `absent`
  again here and removed stale file without kill. Never kill reused IDs.

## Actual tests (this round, helper-only)

- `node --check qa/own-local-stack.mjs` PASS.
- `node qa/own-local-stack.mjs status` with stack down: `health=0 ...` exit 0
  (no services touched).
- `node qa/own-local-stack.mjs stop` with stale `73804/73540`: both `absent`,
  ports closed, stale file removed, exit 0, no kill (PID-reuse safe).
- `node qa/own-local-stack.mjs start` without build manifest: `FATAL missing
  build manifest` exit 2, no spawn (provenance gate holds).
- `build` (npm web + dotnet publish staging + manifest) + ONE controlled
  `start`/`stop` cycle under fresh memory dummy env/keyring MAY be run once
  (ports 15396/98 only, currently primary-stopped/free); full monolith
  (`advisor-integrated-qa.mjs` 210) NOT run here (parallel author owns it).
  Record elapsed/budget/provenance below after execution.

## Provenance log (actual, helper-only round 2026-11-04)

- Build `node qa/own-local-stack.mjs build`: SUCCESS. commit=`2adbcde91409e563b4cfb147df0dd264e87f59d6`, dirty=true (`M qa/own-local-stack.mjs`; `?? docs/own-local-stack-hardening.md`), dllSha=`2571b70d05b95e5340ab48fe3085f2b049d035118891d4f8f8476c67e77d4e0b` (size per manifest), wwwrootSha=`43370ebcd30f2fed28e8f463af8fe7fd51ef1ec384dc1e6944302675e353885f`, served JS=3 CSS=2, qaSha/fakeSha/helperSha recorded, node=`v22.22.1` dotnet=`10.0.301` builderPid=`46012`. Rebuild elapsed=`8051ms` (initial fresh with npm ci `23259ms`), budget `600000ms`. `build-manifest.json success:true` at `OWN/build-manifest.json`.
- First start without manifest: `FATAL missing build manifest` exit 2, no spawn (provenance gate holds).
- First start with relative DLL: `FATAL child identity MUST mismatch` (api cmd `dotnet SimCEO.Api.dll` lacks absolute DLL), fresh cleanup, no orphan, ports free. Fixed spawn to `[EXPECTED_API_DLL]` absolute; rebuilt manifest.
- Controlled start (ports 15396/98, primary-stopped/free, dummy QA keyring): `provenance ok buildCommit=2adbcde91409 startHead=2adbcde91409`, `spawned api=20208 fake=21624 nonce=mw1zpyrc-570e61 controller=22180`, `boot ok instance=qa-author-15396 store=inmemory`. apiIdent exe=`C:\Program Files\dotnet\dotnet.exe` cmd=`dotnet C:\...\own-15396-15398\publish\SimCEO.Api.dll` creation=`/Date(1793789109050)/`; fakeIdent exe=`C:\Program Files\nodejs\node.exe` cmd=`node .../qa/advisor-integrated-fake.mjs --port 15398` creation=`/Date(1793789109056)/`. `manifest.json`/`run.json`/`pids.json` record nonce/controller/child identities + shas.
- Status while up: `health=200 instance=qa-author-15396 ready=200 store=inmemory fake=200`.
- Controlled stop `node qa/own-local-stack.mjs stop`: `killed api pid=20208 (creation-verified)`, `killed fake pid=21624 (creation-verified)`, `after-stop apiOpen=false fakeOpen=false`, exit 0 (~3s, budget `25000ms`); controller observed `cleanup: api-exit` and exited; `pids.json` removed, no `pids.failed.json`. Earlier stale `73804/73540` both `absent`, removed without kill.
- No PG/Docker/real-provider/`.env`/human `5173`/`15180`/`9333`/shared-port/global-kill/other-root involvement. All child exec `windowsHide:true`, bounded array args, no shell (`npm` via `node npm-cli.js`, `dotnet`/`git`/`where.exe`/`powershell.exe`/`tasklist.exe` direct).

## Repair revision 2026-11-04 (CODE ONLY, UNEXECUTED)

Base `a054f19` (e613 helper + 286 monolith + unchanged ff7 production). Primary inspected actual diffs and confirmed regressions; this round repairs exactly those existing requirements, no invented extra global security work, no production edits.

1. `procIdentity`: nonzero CIM exit with empty stdout now returns `unavailable` (never `absent`). Only a successful CIM query (`status 0`) with empty/`null` output proves death. Nonzero exit, spawn error/signal, parse failure, or incomplete identity stays `unavailable` and is retained, never killed, never deleted.
2. `writeBuildManifest` now hashes production inputs BEFORE the build. `cmdBuild` captures `preCommit`/`preDirty`/`preInputs` at start (logged as `pre-build inputs hashed n=...`), passes `pre` into every `writeBuildManifest` success/failure call, and records `inputsCaptured: "pre-build"`. At-write fallback is marked `"at-write"` and never used on the success path.
3. `start` (`verifyBuildManifestForStart`) now compares the FULL pre-build record: production input map equality, `deps.json` sha, `runtimeconfig.json` sha, and `appsettings*.json` hashes, in addition to the existing DLL/index/JS/CSS/QA/fake/helper checks. Missing input hashes refuse with rebuild. Dirty-since-clean and HEAD-moved rules unchanged.
4. `prodInputFiles` expanded to the referenced production inputs: `SimCEO.sln`, `NuGet.Config`, `SimCEO.Api.csproj` + `Program.cs`, `SimCEO.Postgres.csproj`, recursive `server/SimCEO.Api` + `server/SimCEO.Postgres` `*.cs/*.csproj/*.props/*.targets` excluding `bin/`+`obj/`, `web/package.json` + `package-lock.json` + `tsconfig.json` + `vite.config.ts` + all `vite.*.config.ts` + `index.html` + `boardroom-template.html` + `human-mount.html`, and recursive `web/src`. The prior top-level-only `Data/Domain/Hubs/Work` enumeration plus missing Postgres/config/dependency inputs no longer understates the source-to-artifact set.

Validation this round: `node --check qa/own-local-stack.mjs` PASS; focused in-process pattern checks (CIM-unavailable branch, pre-build capture, input/deps/rc/appsettings gates, expanded inventory markers) present. No `build`/`start`/`stop`/`status`, no services/network/browser/ports/PG/Docker/`.env`/providers run here. Actual fresh build + start/stop cycle and numbers are for the primary to produce after review.

## Follow-up block: dedicated e613+qa286 independent review (read 2026-11-04, CODE ONLY)

Confirmed findings in scope fixed here (CODE ONLY, UNEXECUTED, no production edits):

1. Fake exact args: `validateInitialIdentity("fake", ...)` now requires the exact `--port 15398` argument (exact spawn vector `node [EXPECTED_FAKE_JS, --port, FAKE_PORT]`; API spawn stays `dotnet [EXPECTED_API_DLL]`). Basename + absolute-path-substring rules preserved; exact dotnet/node host-exe resolution was not invented.
2. Kill-first cleanup ordering: `failCleanupAndExit` and `onSig` now kill through retained child handles FIRST, then take the bounded CIM snapshots for forensics, then run `cleanupFresh` on its own fresh deadline. No snapshot runs before the sibling is signalled; retained-handle kill is the ownership proof, CIM `absent` verification still gates success and `unavailable` still fails closed with metadata retained.
3. Served-file inputs: `web/public/*` (today `logo.webp`, the favicon served at `/logo.webp` via Vite public-dir copy) added to `prodInputFiles`; `package-lock.json`/`tsconfig.json`/all `vite.*.config.ts`/`human-mount.html` already covered in the prior block.
4. Full output inventory + comparisons: `publishOutputInventory` now also records `dlls` (every top-level publish `*.dll`, catching the staged `SimCEO.Postgres.dll` and dependency DLLs) and `wwwrootAll` (every served file, covering `boardroom-template.html`/`logo.webp`/JS/CSS/index alike). `writeBuildManifest` persists both; `start` refuses on any mismatch. The prior DLL/index/JS/CSS/deps/runtimeconfig/appsettings/input-map gates are preserved.
5. Dirty-build input drift: with `b.dirty === true` the old HEAD/dirty rules could pass changed sources against old outputs; the new current-vs-manifest production-input map comparison now refuses any input drift regardless of the dirty flag.

Validation this round: `node --check qa/own-local-stack.mjs` PASS; pattern checks for the port gate, kill-first order, public inputs, and dlls/wwwrootAll record+compare present. No `build`/`start`/`stop`/`status`, no services/network/browser/ports/PG/Docker/`.env`/providers run here. Out of scope and left for the primary: F10/F11 monolith predicate redesigns (non-owned fake fixture + production semantics + runtime-required), F6-remainder per-locator caps and Secretary window placement, and all rendered/execution acceptance.

## Repair revision 2026-11-04 CODE ONLY, UNEXECUTED (this root, owned helper only)

Base 0f8d066. No production edits; no services/network/process-control/PG/Docker/.env/providers run here. node --check clean only; in-process actual-helper probes only.

- Exact executable+argv: dotnet/node hosts resolved absolute (where.exe dotnet.exe + process.execPath node); spawns use absolute hosts; validateInitialIdentity requires resolved-exe equality plus exact full argv (api [dll]; fake [fake.js --port 15398] with --port=15398 accepted, no extra tokens) via quote-aware argv split and case-insensitive resolved-path compare. Basename/substring checks replaced, never weakened.
- CIM terminating: every nonzero query exit is unavailable regardless of stdout (kept); non-alive/unavailable initial identities FATAL; unavailable after spawn retains FAILFILE and cleans up; stop/final verification treats unavailable as retain-and-FAIL, never dead.
- Shared cleanup deadline: failCleanupAndExit/onSig kill first via retained handles with NO blocking pre-queries, then snapshot inside cleanupFresh on the SAME fresh deadline via procIdentityBounded (remaining-capped, deadline-exceeded yields unavailable+retain). cleanupFresh identity+TCP checks all capped to the same deadline; stop pre-kill and final verifications bounded to stopDeadline with deadline-exceeded retained as failure (no unbounded queries past budget). Stale-pidfile/boot identities bounded to startDeadline remainder.

Explicitly NOT executed here: build/start/stop/status, CIM queries, port checks, PG/Docker/.env/providers. Primary runs fresh build/runtime and independent review.
