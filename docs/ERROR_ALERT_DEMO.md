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

307 offline application tests and syntax checks passed. The prepared parser suite failed before and passed after (9 tests). An isolated real PostgreSQL-compatible execution verified expiry/revision/claim/transition/role behavior. Live PR and heard-call acceptance are recorded separately after a real rehearsal.

## Credits

This adapts the existing MVP Sentry verifier, GitHub App adapter and Twilio transport. The prepared parser repair, narrowed PR-and-call orchestration, one-use storage and tests were written with Codex during the hackathon. Existing demo sources are retained in their existing repository; reviewed credential-free source copies are used only as test fixtures.
