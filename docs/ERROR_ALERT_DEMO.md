# Error notification and prepared draft PR

This submission path is deliberately small: the existing Common Ground Send button posts the fictional plant CSV; Sentry sends its signed alert; Errand opens a draft PR with a prepared parser fix, then calls the configured test number about the error and PR. It does not merge or deploy the fix.

Codex prepared and executed the regression suite during the hackathon. It fails on the original CRLF-only parser and all nine tests pass after accepting LF and CRLF. This is a prepared fix for one known controlled bug, not a new coding run at event time. The original hosted coding rehearsal stopped before a PR; it is not claimed as successful.

## Rehearsal

1. Apply the additive `db/alert-demo.sql` to the existing Supabase project. Keep existing settings; no new credentials are needed.
2. Open `/incident.html`, enter the existing operator token privately and read the current revision.
3. Approve one prepared-fix PR and one error-notification call on that exact revision. Approval expires after ten minutes if unused.
4. Click Send once on Common Ground. A real signed Sentry alert must match the fixture and approved revision.
5. Follow the draft PR link and answer the actual call. Record whether you heard it; API submission alone is not heard-call proof.

The worker checks all four reviewed source hashes and the trusted GitHub workflow before making a change. It can change only `lib/upload-parser.js` and `tests/upload-parser.test.js`. It creates a draft PR using the existing GitHub App and never calls merge. An atomic claim prevents duplicate deliveries from repeating the PR or call. Unknown write outcomes require manual reconciliation rather than retry. The call uses fixed truthful wording and the existing configured test recipient.

## Verification

315 offline application tests and syntax checks passed. The prepared parser suite failed before and passed after (9 tests). An isolated real PostgreSQL-compatible execution verified expiry/revision/claim/transition/role behavior. Live rehearsal on 1 November at 16:33 London: the real signed alert opened draft PR #3 in the controlled demo repository, changing only parser and regression test. Its upload-regression check passed on `1498c7967e473ae3b7fd40e3a681a50d68d6bd62`. Twilio accepted the error-notification call. The owner reported that the phone rang; hearing the full message remains unconfirmed. No merge or deployment occurred.

## Credits

This adapts the existing MVP Sentry verifier, GitHub App adapter and Twilio transport. The prepared parser repair, narrowed PR-and-call orchestration, one-use storage and tests were written with Codex during the hackathon. Existing demo sources are retained in their existing repository; reviewed credential-free source copies are used only as test fixtures.


## Up to ten recording takes for one hour

The owner extended the recording allowance to ten additional Send-triggered calls for one hour. Apply the additive `db/alert-recording.sql` after `db/alert-demo.sql`, then enable a server-only recording allowance bound to the reviewed base commit, existing draft PR and its exact head. The allowance expires after one hour, permits at most ten calls, and requires 60 seconds between accepted captures. It is never automatically renewed.

Each take requires a fresh signed Sentry `event_id` and `datetime` after the allowance was enabled. Sentry retries retain the capture ID and cannot spend another take. The worker revalidates the source, existing PR and both prepared file contents. It reuses an open draft, or creates one replacement draft if the prior PR is closed without merging and the reviewed code is unchanged. It saves the replacement for subsequent takes before calling the configured test number. It performs no merge or deployment. Changed source/PR contents, a merged PR or an uncertain prior write stops further takes. The announcement says the draft PR is ready for review.

Verification: 315 application tests, syntax checks and a real PostgreSQL-compatible recording test passed. The database test covers the ten-take cap, old timestamps, wrong revision, duplicate delivery, cooldown, expiry, single claim, PR reuse and denied anonymous access. These tests do not place live calls; fresh recording takes still require the owner's Send click.


The 17:12 London extension updates only the existing recording table's quota/expiry constraints and its explicitly authorized allowance. The hosted migration is `extend_recording_takes_to_ten_for_one_hour`; existing installations require that upgrade, while the current `db/alert-recording.sql` contains the new defaults for a fresh schema. Capture deduplication history, cooldown and completed jobs are preserved. No application-runtime redeploy is needed for the allowance to take effect.


## Closed PR recovery and visible failure reasons

The 1 November follow-up after the 17:00 hackathon deadline fixes recording runs stopping when the owner closes the previous PR. A fresh signed Send can replace an unchanged, unmerged closed PR with a new draft containing the same reviewed two-file patch. An atomic compare-and-set updates both that job and the recording allowance before the call, so subsequent takes reuse the replacement. This preserves the existing quota, expiry and 60-second spacing. Duplicate delivery cannot create another PR or call.

The migration `recover_closed_recording_pr_and_save_safe_failure_reason` is required for an existing schema; a fresh `db/alert-recording.sql` includes it. Jobs now save a fixed failure category, displayed on the operator page, instead of silently losing the cause. Provider messages, phone numbers and secrets are not saved in this status. A lost PR-creation, storage or call response remains uncertain and blocks automatic retries.

Validation: 315 application tests and syntax checks pass. The isolated SQL test verifies atomic replacement, stale binding rejection, reuse by the next take, no extra quota consumption during replacement, safe failure categories and restricted access. A live signed capture at 17:53:26 London created replacement draft PR #4, saved it for reuse and completed call submission at 17:53:35. GitHub confirmed only parser/test changes and upload-regression SUCCESS on `752c30c9e35db9f6024728ca139b143ba49d1e79`. This is 8.83 seconds after server acceptance, not a measured click-to-ring time. Hearing the message remains unconfirmed.
