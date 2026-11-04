# Advisor live-provider proof — primary-only run book

Own files (Muse-authored, sole script author): `qa/advisor-live-provider-proof.mjs` + this doc ONLY.
Prod `509e6a6ea4a9c9078774f8963eca446760878cdc` is frozen — no server/web/compose/Dockerfile edits.
Muse never executes the script against a service (`node --check` + code-only validation only);
PRIMARY executes it. Muse performs no HTTP/provider/Docker/PG/browser/services/.env/keys/process
control — code-only check + refusal gate.

## What it proves (bounded, actual provider)

One fictional public-domain advisor (**Sherlock Holmes**) through the REAL routes against the
isolated Docker project selected by `QA_LIVE_PROJECT` (allowlist exactly `simceo-advisor-real-15190` OR `simceo-advisor-real-15190-v2` OR `simceo-advisor-real-15190-v3`)
(expected source pinned by `QA_LIVE_SOURCE_COMMIT` full 40hex, mandatory match against trusted proof `sourceCommit`; default `509e6a6ea4a9c9078774f8963eca446760878cdc` backcompat for the old project, explicit full-40hex required for `-v2`/`-v3`; fresh PG/appdata volumes)
at the EXACT origin `http://127.0.0.1:15190`:

1. Trusted primary proof JSON (`QA_LIVE_PROOF_PATH`) pins `project`, `containerId` (full 64hex),
   `imageId` (full 64hex, `sha256:` prefix allowed), `sourceCommit` (full 40hex, exact match to `QA_LIVE_SOURCE_COMMIT` (default `509e6a6ea4a9c9078774f8963eca446760878cdc`), `servedIndexSha256` (64hex),
   `apiOrigin` (exactly `http://127.0.0.1:15190`). Actual trusted identity (primary
   docker-inspect OUTSIDE the script; the fresh project under test must be pristine no accounts):
   containerId `55fd668e4bcca1e50d5220c9f3484bebb3175fa6375031b328e960c18b0172d0`,
   image sha256 `eb48b80d1063a25051e029bcf4798e699d68e8218f132ebd9e34dbc99399781f`.
   The script only validates the fields (length-6 ids and prefix-only commits rejected).
2. Freshness gates (fail-closed): `/health` ok, `/ready` `ready=true` + `store=postgres`,
   fetched `/` sha256 exactly equals `servedIndexSha256`, `/api/auth/status` pristine
   (`accountCount=0`, `authRequired=false`). ONE fresh attempt only — no resume mode.
   Resume was removed: after registration `authRequired` is true and the script retains
   no other credentials, so a "fresh login resume" would register yet another random
   account (impossible without inventing credential persistence). No automatic extra
   accounts/retries; primary preserves failed QA data and chooses an explicit new owned
   run when needed.
3. In-memory random QA-only register/login (password/token never logged raw, values never stored;
   artifact keeps nonsecret identity only: email + advisor id).
4. Real configured model status + admin spending in its ACTUAL allowed mode. Fresh-DB
   default `warn` / cap `null` / `enforced=false` is a VALID policy — the script does NOT
   invent a mandatory enforced-cap=true/number requirement (primary never requested force-cap).
   Read: mode `warn`/`block`/`off` ONLY (empty mode fails closed: the first actual run stopped here with zero paid calls on the real fresh-product empty-Mode default bug; the fixed source must present a real mode, `warn` goal legitimate), cap number OR null, `enforced === (mode==block && cap!=null)`,
   effective `overCap` (`cap!=null && known>=cap`) in `block` mode stops paid calls.
   Policy is observed, never changed (no settings/spending PUTs). Bounded to
   1 research + 1 chat + 1 audition (+1 addl ready authorized).
5. `POST /api/roster/quick` then `POST /api/roster/{id}/research` (focus only; background and URLs
   fall back to stored inputs). The POST awaits the FULL server run (ResearchDeadline <=180s):
   one absolute research end from BEFORE POST (<=185s, within TOTAL 480s). The POST promise is
   tracked while concurrently polling the actual `GET /research` stages; request/body end is
   bounded; the POST is awaited exactly once. No retries/double POST. Polls are free GETs.
   Terminal requires `stage=done` + `draftStatus=done` with STRICT `fetched===true` evidence
   only: non-empty excerpt AND (URL in the approved seed URLs OR actual owned fetch
   `ownerSupplied===true`). Excerpt alone never proves fetch (`fetched===false`/missing
   always fails); only the strict set is serialized. Honest stop on `unsupported`/`failed`
   (no forced retries).
6. Canonical readback via `GET /api/roster?accountId=` + exact-ID unwrap (`entry.profileJson`),
   then explicit `PUT /api/roster/{id}` save of the researched draft (background + all other
   fields round-tripped byte-identical so the dossier is preserved). The researched draft differs
   from the seed, so the version contract is exact +1 (same-profile no-op concern does not apply;
   no edits to this expectation are necessary). Dossier proof after save: `stage=done` with
   explicit `draftStatus=saved`, inputs background/URLs preserved.
7. Roster-only direct chat ONCE (narrow question about uncertain witness claims) + audition ONCE
   via `/api/auditions` with the same canonical entry; both answers pinned to the current version
   and asserted `stored=false`.
8. No meeting integration claimed: boards count asserted unchanged before/after; no board run.
   Any unexpected 403/model-policy (402/503/504/499)/research error stops immediately with no retries.

## Call budget

At most 1 research + 1 chat + 1 audition (paid/model). App-internal research subcalls
(fetch round + up to 2 model calls) are natural and server-bounded; TOTAL execution is bounded
at 480s hard execution timer with remaining-clamp on EVERY execution body/acquisition/poll
(excl. cleanup fs writes), plus ONE absolute 15s cleanup allowance shared by abort/drain +
artifact write so an expired execution still writes its failure artifact within the cleanup
budget (not mapping AbortControllers to `Promise.resolve`; timers cleared, bodies already
consumed, in-flight aborted, failure artifact written; no success after execution expiry or
on failed pending drain; no separate 15s + 10s beyond the one allowance). Artifact write
failure exits nonzero. Failure artifacts
retain completed research/paragraph/identity-nonsecret/partial results instead of discarding
the doc. No unhandled-rejection swallows (first unhandled turns the run FAIL).

## Invocation (primary only)

Set QA_ALLOW_LIVE_PROVIDER=1, QA_LIVE_PROJECT, QA_LIVE_SOURCE_COMMIT, and QA_LIVE_PROOF_PATH to the trusted live-proof JSON, then run:
QA_LIVE_PROJECT=simceo-advisor-real-15190-v3 QA_LIVE_SOURCE_COMMIT=<actual-primary-integrated-HEAD-full-40hex> QA_ALLOW_LIVE_PROVIDER=1 QA_LIVE_PROOF_PATH=/path/to/live-proof.json node qa/advisor-live-provider-proof.mjs

Proof JSON contract (all required): project must equal QA_LIVE_PROJECT (allowlist exactly simceo-advisor-real-15190 OR simceo-advisor-real-15190-v2 OR simceo-advisor-real-15190-v3), containerId full
64 lowercase hex (primary docker-inspect identity), imageId full 64 hex (`sha256:` prefix
allowed), sourceCommit full 40 hex exactly equal to QA_LIVE_SOURCE_COMMIT (default 509e6a6ea4a9c9078774f8963eca446760878cdc backcompat; explicit full-40hex mandatory for -v2/-v3),
servedIndexSha256 64 lowercase hex, apiOrigin exactly http://127.0.0.1:15190.

First actual run (old project `simceo-advisor-real-15190`) stopped fail-closed at the spending gate with `Mode` empty before research/chat/audition (zero paid calls), confirming the real fresh-product default bug (separate fix underway); its stack data stays preserved untouched (no resume/accounts/deletes by this script). The `-v2` rerun is a NEW fresh Docker project reusing origin 15190 with the fixed source: one fresh attempt only, no paid retries. Strict `fetched===true` evidence and the ONE absolute 15s cleanup allowance are unchanged. Same-API-origin 15190, full container/image 64hex, and served-index proof requirements are unchanged.

## v2 outcome record (not overwritten) + forthcoming v3

- v2 run (`simceo-advisor-real-15190-v2`): structural checks 62/62 PASS. Structural only — counts are not semantic ratings.
- Dedicated semantic review of the v2 artifact: character behavior PASS for the sampled Holmes scenario (cautious reasoning, no overclaim on uncertain testimony), but stored claim attribution FAIL — every dossier claim carries the same three citations, one with an empty excerpt, whose retained excerpts do not substantiate the twelve distinct publication/method/forensic/cipher claims (product provenance defect). This does NOT support an unqualified semantic-and-evidence release PASS. The v2 record stands as-is; nothing here overwrites it.
- New production pipeline `cbc8086` is under review. The eventual v3 proof (`simceo-advisor-real-15190-v3`, forthcoming fresh stack at the same exact origin `http://127.0.0.1:15190`) uses the actual primary integrated HEAD at proof time as `QA_LIVE_SOURCE_COMMIT` (explicit full 40hex) — never a hardcoded older SHA. All other proof requirements (fresh volumes, pristine accountCount=0, strict `fetched===true` evidence, one fresh attempt, call budget, 480s TOTAL + one 15s cleanup allowance, full 64hex container/image + served-index proof) are unchanged.

No resume envs. Optional override QA_LIVE_RESULT_PATH for the owned result artifact location
(default qa/proof/advisor-live-provider-proof-<runTag>.json, plus a .md twin).

## Outputs

- qa/proof/advisor-live-provider-proof-<runTag>.json — full structural record (provenance,
  freshness, model/spending, research stages + elapsed + evidence snippets, full returned research claims (`research.claims`, bounded) + 3 paragraphs,
  chat/audition answers, structural checks).
- .md twin — human-readable paragraphs, evidence-backed URLs, elapsed/research stages,
  answers, and check list, for primary + dedicated AI review.

## Remaining semantic gate (NOT closed by this script)

Automatic checks are structural only (status codes, shapes, version pins, byte equality).
They are not model self-rating or claim-tone proof. Structural counts (e.g. 62/62) and semantics are separate: retaining claims/excerpts alongside the compiled paragraphs does not prove claim truth — that is the job of the dedicated semantic review. The paragraphs, chat answer, and audition
answer still require dedicated AI semantic review (grounding fidelity to the two upstream
URLs, no overclaiming on uncertain testimony, in-character consistency) before any claim that
the provider path is qualitatively good. semanticGate PENDING in the artifact records this.

## Direct v4 verification
The allowlist additionally accepts exactly simceo-advisor-real-15190-v4 with an explicit full source commit. V3 is retained as failed evidence: the provider accepted the request but exhausted its 2048-token output allowance and returned incomplete research. The application now reserves 4096 research output tokens and requests at most eight concise claims, preserving the two-call and whole-run deadlines. V4 is one new fresh attempt in new volumes, with no resume or hidden retry. Artifacts retain full container/image IDs and mark index agreement only after the freshness check passes.


V5 additionally permits exactly simceo-advisor-real-15190-v5, with the same full-source proof and one-fresh-attempt limits. V4 completed both model calls but honestly returned unsupported: paragraph extraction had clipped narrative quotes behind an infobox. The candidate now retains visible block boundaries; 108 security checks, 33 provenance checks, and a direct two-page public fetch passed before this new attempt. Earlier results and volumes remain retained.

