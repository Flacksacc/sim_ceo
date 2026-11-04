# Phase8 Guests Closure QA Status

Scope: QA only in this worktree at b2acd1b. Production frozen read-only. No production source edits. Primary owns all runtime, services, SQL, and browser execution. Muse authored, node check only.

## Completed by Muse (authored, primary to run)

- Strict SignalR hardened: exact owned instance and fake provenance gates before auth, real Bearer registrations with distinct tokens, complete setup asserts, separate connections for denied joins, positive both guest connections plus multi meeting plus unrelated control with exact returned Sequence and Content markers, publish immediately after DELETE 204 before await, await revocation event AND closed with no OR fallback, all multi connections plus exact zero after plus control received, explicit POST join after regrant 200 with membership IDs not empty, deliberate leave with exact zero plus notify and close plus same user other grant still usable, serial await with shared remaining deadlines, close tracked in finally, exitCode only with no watchdog.
- Extended hardened: exact API and fake gates plus fresh DB prefix and expected instance gates before auth, asserted setup registrations and board and meeting and grants, approved reject 409 plus exact unchanged bytes preserved, separate grant revoke 403 positive control, no loose statuses.
- UI hardened: exact API and BASE loopback gates plus fake provenance before auth, named invite and My meetings row and read-only settings with no ID counting in DOM, send with request response barrier 201 plus live render, explicit Rejoin plus Leave buttons visible with explicit Leave action, private purge without reload, held messages route released after revoke cannot render with 403, download positive 200 plus exact bytes before then zero 403 after, blob and abort retirement verified, Meeting settings read-only verified with forbidden actions absent.
- PG3 fixed: membership not active now requires row present, so empty array no longer passes.
- Expiry fixture new: qa/phase8-expiry-qa.cjs with setup and recheck modes on owned fresh PG 15441, gates fail closed on DB prefix and expected instance and only own rows, manifest persists membership rowID and joinedAt and grants with no tokens, SQL update not attempted because sessions are memory-only with 14 day lifetime and no clock seam and no session table, so natural expiry revoke and 401 remain unproven. Positive delivery and membership durability are proven. No deleting as expiry, no logout as expiry, no production hook, no mirrored predicate, no service start from fixture.
- Commit probe new: qa/GuestsGetCommitProbe with actual Atomic plus store types and MemFaults seam, proving shape rollback with no partial membership or message and gate reusable. Full GET handler with HttpRequest and 503 no-data remains unproven without a testable helper, which would require a production change that is frozen. No shipping hooks, no copied predicate claimed as handler proof.

## Still missing until primary runs

- Strict, extended, UI, PG, expiry setup, expiry recheck after owned restart, and commit probe have not been executed by Muse. No services, SQL, runtime, browser, Docker, env, keys, or human ports were used by Muse. Only source and node check were used.
- Full expiry with publisher suppress immediately after expiry before 30s sweep plus owner control marker plus real revoke disconnect plus HTTP 401 is not claimed.
- Full PG persist with non resurrection across owned restart is not claimed until primary runs setup then recheck on the same owned server with manual restart.
- Full UI with rendered layout on owned headless Edge at 15340 is not claimed until primary runs.
- Full commit failure proof for the new GET path with precise handler state is not claimed; shape rollback only is claimed with explicit limitation.

## QA paths touched

- qa/phase8-signalr-strict-qa.cjs
- qa/phase8-extended-qa.mjs
- qa/phase8-guests-ui-qa.cjs
- qa/phase8-repair-pg3.cjs
- qa/phase8-expiry-qa.cjs (new)
- qa/GuestsGetCommitProbe/GuestsGetCommitProbe.csproj (new, copied from CommitFaultProbe)
- qa/GuestsGetCommitProbe/Program.cs (new)
- qa/docs/phase8-guests-closure-qa.md (new, this file)

No production source, Profile, advisors, Send, Records, Usage, Jobs edits. No other worktree writes.
