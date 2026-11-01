# Controlled upload repair and callback

The fast demo uses the existing small LF/CRLF parser bug. A chat popup may present the sample as an attachment; its Send action must keep using `POST /api/upload` with exactly `{"sample":"plants"}`. This is an error surfaced by the frontend and captured by the demo's Node SDK, not an arbitrary browser exception.

## Implemented path

1. The operator reads the current demo revision and explicitly approves one run at `/incident.html`.
2. A signed matching Sentry alert consumes that ten-minute, exact-revision approval atomically in the existing Supabase database.
3. One hosted Codex run using `gpt-6.1-sol` adds a failing regression, runs it, fixes only the parser, and executes the same tests plus an independent oracle. The application validates provider command records and exact artifact hashes.
4. The worker opens a two-file PR, verifies the trusted GitHub Actions workflow on its exact head, and creates an exact-tree merge commit. A non-force ref update rejects concurrent changes to main. Server-side branch protections remain in force.
5. It confirms the PR's merge commit, waits for the public health response to identify that commit, then repeats the original sample upload. Health alone never proves success.
6. Only after the live upload passes, Twilio receives fixed completion TwiML for the already configured test number. API acceptance is `submitted_not_verified`, not proof the recipient answered.

This slice uses a short completion announcement. The interactive findings/approval call, general phone conversation and older-adult scenario remain separate prepared/future work. Sentry issue resolution is manual in this slice; it is not part of the completion claim.

## Private activation, performed by the owner

The owner reports the existing runtime settings are already on Vercel project **errand-hackathon-day**. Keep those values private; do not create replacement credentials or copy them into this repository. The agent does not inspect deployment environment settings or run credential-dependent acceptance checks.

The single new setting is `ENABLE_FAST_INCIDENT_DEMO=true`. Reuse `ENABLE_GITHUB_APP=true`, `ENABLE_LIVE_VOICE=true`, `OPENAI_AGENT_MODEL=gpt-6.1-sol`, the existing OpenAI key, Supabase URL/secret key, operator token, GitHub App settings and Twilio settings. `GITHUB_DEMO_REPO` must select `Jishan97/errand-agent-demo`; `GITHUB_DEMO_URL` must be its canonical HTTPS Vercel origin. The App's existing installation needs Contents/Pull requests write and Checks/Actions read. `PUBLIC_BASE_URL` for this deployment is the main app origin. Existing connection IDs are read from the same database; no new onboarding is created.

The parent workspace's sanitized `mvp/.env.example` is the only configuration template. The old `ENABLE_INCIDENT_DEMO` controls the prepared MVP flow and does not activate this fast path. Saving a Vercel value requires a new deployment before it is used.

The additive schema is [db/fast-incident.sql](../db/fast-incident.sql). It creates two private, RLS-enabled tables and five service-role-only RPCs without changing old tables or the old scheduler. It was applied to the existing database during this build; do not apply it a second time. Deployment metadata and role grants were verified through the connected database tool; no resident/contact/configuration rows were read.

## Live checkpoints

1. In Sentry, set the existing internal integration Webhook URL to `https://errand-hackathon-day.vercel.app/api/webhooks/sentry` and enable Alert Action. Use a matching Issue Alert action for the demo tag `errand_demo=upload_lf_v1`. Generic Issues/Seer lifecycle subscriptions are not this receiver's input. Ensure the rule fires on the next event in the existing issue; a new-issue-only rule will not fire for every repeat.
2. Open [the rehearsal page](https://errand-hackathon-day.vercel.app/incident.html). Enter the existing operator token privately. Read the current revision, review the displayed scope and arm one run. This performs real bounded reads and saves the approval. Finish collaborator UI commits before this step.
3. Trigger the fictional sample once in the [existing demo](https://errand-agent-demo-jishan97s-projects.vercel.app/upload.html). Confirm the new Sentry event and observe a run on the rehearsal page.
4. Follow `repair_poll → ci_wait → deployment_wait → callback → completed`. Inspect the PR and verify the sample now succeeds. Confirm the completion call was actually received. Record measured elapsed time only after this live run.

Target: 30–60 seconds. Hosted coding, CI, deployment and ringing time can exceed this. No shortcut announces success before replay. An offline test is not a latency measurement.

## Stop and resume behavior

Progress is persisted between each step. The webhook returns after durable intake; Vercel `waitUntil` keeps the bounded worker running for this invocation. Immediately executable phases proceed without artificial ten-second delays; pending provider stages poll every two seconds. A 220-second driver budget leaves room inside the 300-second Function limit. There is no new scheduler. If it pauses, the operator can resume the saved run; completed and uncertain writes cannot replay.

Two-minute leases protect concurrent workers. An interrupted session creation, PR creation, merge or call submission is quarantined as `unknown`; investigate the provider outcome before any retry. Unknown outcomes block new approvals. A failed run at the same revision also requires review rather than a misleading new arm. After reconciling any remote work, use a new reviewed revision for a new rehearsal. Never reset a repaired demo automatically or force-push over collaborator work.

Only approved source and synthetic fixture content reach the hosted workspace. It receives no service credentials and has networking disabled. Public status is operator-protected and contains bounded phase/test/PR/commit fields; phone numbers, call IDs, raw Sentry payloads and provider error bodies are not returned or logged.

## Local verification and credits

Run `npm ci --ignore-scripts`, `npm run check`, and `npm test` with Node.js 24. These tests inject fictional configuration and make no live provider calls. `npm run dev` serves the rehearsal layout, but local provider access remains disabled. SQL execution tests are in [db/test-fast-incident.mjs](../db/test-fast-incident.mjs); run with an explicit temporary installation of `@electric-sql/pglite@0.5.14` as described in that file.

The Sentry parser, hosted coding proof protocol, GitHub App/token binding, source allowlists, checks, replay logic and Twilio transport are selectively adapted from the pre-event Errand MVP. During the hackathon, Codex added the combined approved run, durable single-run storage, faster driver, exact-tree merge, completion caller, operator page and regression/integration tests. The demo app and service setup were reused in place. No external visual assets or UI templates were added here.

Current references: [OpenAI hosted environments](https://developers.openai.com/api/docs/guides/agents-api/environments/openai-hosted), [Vercel waitUntil](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package#waituntil), [GitHub non-force ref updates](https://docs.github.com/en/rest/git/refs), [Twilio Calls](https://www.twilio.com/docs/voice/api/call-resource). Supabase's informational [RLS-without-policy advisory](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy) is intentional for these private service-only tables; public roles have no access.
