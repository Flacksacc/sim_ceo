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