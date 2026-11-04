# Records launcher cb-final — launcher-side findings 1/2/3 (code-only)

## Ownership and scope
- Sole/code-test author owns ONLY `qa/records-phase5-launch.mjs` and this doc
  `docs/records-launcher-cb-final.md`. Parallel other-file author exists.
- Browser file `qa/browser/records-phase5-onedoc-ui.cjs` is NOT edited here.
  Browser author owns the browser file and implements the cooperative env deadline.
- Frozen: production `181140d` and accepted formatter `19dcda0` (`human-format.ts`
  exactly matches `19dcda0`). No production or other QA files changed.
- Existing full matrix preserved (HTTP + browser suites, ports, provenance,
  exact origins, refusal guards, TOTAL guard at final success).
- CODE ONLY. No services, network, browser, process, PG, Docker, provider,
  `.env`, human, or other worktree mutations. Syntax (`node --check`) and
  in-process/static probes only.

## Author runtime evidence (not independent acceptance)
- Primary exact combined `c971b55`: fresh **226 HTTP / 234 browser / 0 fail**,
  elapsed **73431 ms**, **cleanup closed passed**.
- Static review findings are still not closed. Test-green does not mean
  review-pass. Real PostgreSQL remains pending. 226/234 is author evidence,
  not independent acceptance.

## Finding 1 — cooperative earlier deadline + teardown reserve (launcher side)
- Agreed contract (browser implements; launcher passes):
  `RECORDS_QA_WORK_DEADLINE_EPOCH_MS` (absolute milliseconds) and
  `RECORDS_QA_CLEANUP_MS=20000`.
- Launcher: `RECORDS_QA_CLEANUP_MS=20000`, `RECORDS_QA_PARENT_MARGIN_MS=20000`,
  `RECORDS_QA_PARENT_RESERVE_MS=40000` (>= cleanup + margin).
- Browser parent force-timeout = `min(960000, remaining - PARENT_RESERVE)`;
  cooperative work deadline = `browserStartMs + parentTimeout - CLEANUP_MS`,
  passed BEFORE the parent force-timeout with teardown reserve.
- Guard: if `remaining - PARENT_RESERVE < 60000` (or computed window < 60000),
  throw `TOTAL insufficient remaining...` instead of clamping to a tiny
  watchdog-killing timeout. `runBounded` reserve now uses `PARENT_RESERVE_MS`.
- Browser internal 900s watchdog untouched (not owned here).

## Finding 2 — spawn errors attached before pid check
- New `attachSpawnError(child, label)`; `spawn(...)` is wrapped immediately:
  `attachSpawnError(spawn(...), "fake"|"api")` runs BEFORE `if (!pid) throw`
  and before `children.push(...)`. No late `.on("error")` after acquisition.

## Finding 3 — child AND build env allowlist, no Node startup hooks
- `allowPrefix` is now `["NUGET_", "NPM_", "PROGRAM"]`; `NODE_` excluded so
  inherited `NODE_OPTIONS` / `--require` / `--import` cannot enter fake/suite.
- Explicit strip in `childEnv()` and `suiteEnv()`: any `NODE_*`,
  `NODE_OPTIONS` (case-insensitive) deleted; final `delete out["NODE_OPTIONS"]`.
- `DOTNET_*` still scrubbed except allowlisted telemetry keys; exact controlled
  owned `DOTNET_CONTENTROOT = PUB` (fresh staging) pinned after scrub.
- Builds now use the same allowlist: `buildEnv() === childEnv()` passed to
  `git rev-parse`, `dotnet publish`, and `npm run build` (previously inherited
  `process.env`). Suite envs already flow through `suiteEnv()` (sanitized).
- Sanitized-host log now proves `DOTNET_STARTUP_HOOKS` AND `NODE_OPTIONS`/
  `NODE_*` absent plus `nodeleak=` listing.

## Validation performed
- `node --check qa/records-phase5-launch.mjs` → pass.
- Static/in-process probes: constants present, `NODE_` removed from allowlist,
  strip logic present, `env: buildEnv()` on git/dotnet/npm, spawn-error
  attached before pid check, no late `.on("error")`, deadline arithmetic and
  reserve guard present, browser file unmodified (`git status` shows only the
  launcher + this doc).
- No suites, builds, browser, DB, or network executed.

## Limits / not claimed
- Findings 4–7 (browser suppression/correlation, reload child-state, manager
  validity, matrix card scoping) are browser-side and NOT fixed here.
- Cooperative deadline is half of the contract; browser-side enforcement is
  the parallel author's work and is not verified here.
- No independent-review pass claimed.
## Fresh-17 build failure: actual diagnosis + minimal fix (Muse isolated)
### Actual failure, reproduced (not guessed)
- Primary fresh `17eb4ac` run failed BEFORE services at `dotnet publish status=1` with blank stderr.
- Blank stderr root cause: `dotnet` reports restore/build errors on stdout; old `runBounded` discarded stdout and kept only a 300-char stderr slice.
- Reproduced with EXACT child env (parent env untouched, redacted): `NuGet.targets(782,5): error : Value cannot be null. (Parameter path1)` in `_GetRestoreSettings` / `_GenerateRestoreGraphProjectEntry`. Full inherited env publishes clean (STATUS=0).
- Bisection (exact child env + candidate additions): `[]` fail; `APPDATA` alone fail; `APPDATA+LOCALAPPDATA` fail; shell set alone fail; program set alone fail; shell+program pass; `A+ProgramFiles` pass; `ProgramFiles+APPDATA` pass; `ProgramFiles(x86)+APPDATA` pass; `CommonProgramFiles+APPDATA` fail; `ProgramFiles+LOCALAPPDATA` (no APPDATA) fail.
- Minimal required: APPDATA + ProgramFiles (x86 accepted as alternate; both added for 32/64-bit layout robustness). Standard non-secret Windows shell paths; denyRe unaffected; NODE_/DOTNET_/PG/secrets/ports exclusions unchanged; DOTNET_CONTENTROOT still pinned to fresh PUB.
### Fix in this commit (launcher only, 2 lines)
- `allowExact` += `APPDATA`, `ProgramFiles`, `ProgramFiles(x86)` with inline comment (verified minimal by bisection above).
- `runBounded` now retains redacted build output: `out=` stdout tail (2000 chars; dotnet failures surface at the end) + `err=` stderr tail (1000 chars); light redactor masks api-key/secret/token/password assignments. No isolation weakening: no NODE_OPTIONS/global DOTNET_CONTENTROOT/PG/env secrets admitted, no fake PASS.
- Dedicated independent review `records-24f-51b-independent-review.txt` (frozen 17eb4ac): launcher findings 1-3 STATIC PASS; remaining P2 findings 4/5/7 are browser-side and NOT edited here (any actual browser failures reported back to primary).
### Own complete combined 17 run (instance muse-r597-mw21cp70-9f3f, 2026-11-04 ~06:31-06:34 ET)
- Build with fixed sanitized child env: PASS. Artifact 1833984 bytes (identical size to c971b55 author evidence), wwwroot staged from dist.
- Owned services only: fake + api on 127.0.0.1:15320/15322, unique instance/keyring, provenance proven (boot-bound, chatBefore=0); sanitized-host proof shows no DOTNET_/NODE_ leaks; headless owned browser only. No PG/Docker, no human/shared ports, no other worktrees, no app-source changes.
- HTTP suite: 226 pass / 0 fail (matches primary c971b55 226/0).
- Browser suite (browser file NOT edited here; failures reported back, not fixed): 4 FAILs + 1 FATAL, browser exit status=2, launcher exit=1, cleanup verified (ports closed).
  - FAIL reload-403-preserve-peritem-R1/R2 (per-item child lost on App 403) and FAIL reload-abort-preserve-peritem-R1/R2 (per-item child lost on App abort).
  - FATAL locator.click timeout 20000ms at browser:787 waiting for Reload-editor-from-current-review button that never renders after the failed review query (cf. App isError gate). Confirms independent-review Finding 5 both parts; Finding 7 unreached in this run.
- First attempt (instance mw21b9az-8225): transient MSBuild-node crash status=3762504530 (0xE0434352) after a non-fatal NU1900 warning; the old head-slice truncated the true error tail, which motivated the tail-slice fix in this commit. Clean retry passed build + HTTP.
- No secrets persisted: dummy per-run QA keys only; all run redirect logs and owned .qa publish/keyring dirs removed after the run.
