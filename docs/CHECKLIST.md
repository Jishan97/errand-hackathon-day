# Where we are and what is left

> **Current build — 1 November 2026:** The owner has authorized the controlled repair and completion-call flow. See [FAST_INCIDENT.md](FAST_INCIDENT.md) for the implemented path, owner activation and live acceptance checkpoints. Earlier validation-only/static descriptions below are historical. The receiver still returns `not_connected` when the new feature switch is off.

Reconciled on 1 November 2026. The immediate direction is a small live web foundation, then selective reuse of MVP work. Two demos remain the goal: developer incident assistance first, everyday phone help/reminders for older adults second.

## Done

- [x] On `codex/composio-gmail`: main `38bbe72` integrated with a single-user Gmail operator console, managed OAuth, durable approval/worker/recovery, and 5 MiB image-attachment adapter. [Activation and live acceptance](GMAIL_OPERATOR.md) remain owner-run. General phone/chat and image generation are not implemented by this slice.

- [x] Public hackathon source repository, with work pushed to `main`.
- [x] [Minimal web page live](https://errand-hackathon-day.vercel.app) without sign-in.
- [x] Native GitHub → Vercel production pipeline. A normal subsequent push produced a READY deployment, not just a one-off upload.
- [x] Page, CSS and static `/healthz` content verified anonymously against committed files.
- [x] Local syntax, HTTP, asset/document-link and browser checks for this web foundation.
- [x] Initial collaborator brief, architecture boundaries and staged plan.
- [x] UI-only instructions written for the existing developer demo and published as a single-file draft PR in its private repository. The PR is not merged yet.
- [x] Existing demo source stays under MVP; its repository and deployment connections remain in place.
- [x] Minimal signed Sentry receiver deployed to production in `77ab8f4`, with 13 credential-free tests passing on Node.js 24 and 26. Anonymous production method/authentication/content-type/query checks pass and static assets still match source. It returns validation-only receipts; real signed Sentry delivery remains pending.

## Existing setup to reuse

| Component | Preparation status | What the new hackathon app still needs |
| --- | --- | --- |
| GitHub | Existing App/demo setup is owner-confirmed. Source pushes and Vercel Git delivery are directly verified. | Wire the reviewed, scoped runtime repository tools when the developer slice needs them; then test that actual path. |
| OpenAI / GPT Live | Existing API/voice setup is owner-confirmed; preparation records include provider and real-call evidence. No replacement keys are requested. | Bring over the minimal voice/reasoning/coding integration and run its relevant acceptance check. |
| Twilio | Existing incoming/outgoing phone preparation is recorded. | Connect the selected conversation/callback path to the new app. |
| Supabase | Existing service setup and preparation contracts are available. | Reuse only the task/approval/job storage needed for the selected slice. |
| Sentry | First controlled capture passes; internal integration creation is verified and the owner reports saving updated backend credentials. Receiver deployed in 77ab8f4; offline tests and anonymous production rejection/routing checks pass. Replacement values/private settings were not inspected. | Connect the matching Sentry Issue Alert and prove real signed delivery. Durable incident processing, findings call and repair flow remain disconnected. |

Existing account readiness is different from end-to-end acceptance. The hackathon app has static files plus a validation-only [signed webhook handler](SENTRY_WEBHOOK.md). It has no provider clients, persistent incident intake, phone bridge, worker, coding action or reminder scheduler. Do not re-provision existing integrations or reopen old setup failures without new evidence.

## Next, in order

### 1. Owner: Sentry account and monitoring project

The Node.js demo application already exists. A **Sentry project** is its error-monitoring container inside Sentry's dashboard, not another Node app or Git repository. Choose Node.js as that monitoring project's platform because the existing demo backend runs on Node; the existing source already includes the Sentry SDK.

For this demonstration, one monitoring project for the **existing demo app** is enough:

| Application | Role in the Sentry flow | Setup needed |
| --- | --- | --- |
| Existing demo under `mvp/demos/developer/` | Reports the planted error to Sentry. | Existing Sentry SDK plus the demo project's `SENTRY_DSN`. |
| Main app in `hackathon-day/` | Receives signed Sentry alerts and coordinates the approved Errand response. | A backend webhook receiver, verification secret, project/org binding and scoped API token. It does not need its own monitoring DSN/SDK for this role. |

Monitoring errors inside Errand itself is optional later work. The main app's minimal receiver verifies the target's signed alert; first confirm its production route, then use an owner-run Sentry delivery check before claiming live acceptance.

- [x] Owner reports obtaining the existing demo's DSN after the monitoring-project setup. No new Node app, repository or deployment is required; the private value was not shared or inspected.
- [x] Verify the existing demo's SDK/DSN reporting path: the owner triggered the fictional upload failure and showed the matching **Fictional plant upload failed** issue with one event in Sentry. Private save/redeployment details were not inspected; this is one real capture, not full alert/repair acceptance.
- [x] Create the internal integration with Issue & Event Read & Write. Its saved creation/permission is verified; webhook URL and Alert Action remain blank/off.
- [x] Owner reports adding updated Sentry credentials on the main `errand-hackathon-day` Vercel project, following the numeric-project-ID/org-slug field guidance. Exact values, environment scope and replacement/revocation were not inspected.
- [ ] Verify the saved backend settings through the eventual deployed receiver and an owner-run redacted check. Private save is not authenticated runtime acceptance.
- [ ] Enable the integration's Alert Action only after its receiver URL is deployed and verified, then configure the matching Issue Alert rule.

| Existing setting name | Destination/purpose |
| --- | --- |
| `SENTRY_DSN` | Demo-site Production only: send the fictional error to the dedicated project. |
| `SENTRY_PROJECT_ID` | Errand backend: allowlist the correct numeric Sentry project. |
| `SENTRY_ORG_SLUG` | Errand backend: scope Sentry API operations to the right organization. |
| `SENTRY_WEBHOOK_SECRET` | Errand backend: the integration Client Secret for verifying signed webhook bytes. |
| `SENTRY_AUTH_TOKEN` | Errand backend: the internal integration token for the approved issue API operations. |

These names already exist in `mvp/.env.example` in the parent workspace. No new credential names or template changes are needed. Keep `ENABLE_INCIDENT_DEMO` disabled until the intended backend, migration and rehearsal prerequisites are ready.

The separate demo's only manually configured Sentry input is `SENTRY_DSN`; its existing upload handler obtains release metadata from Vercel automatically. Its prior captured event already passed. Main-project credential changes do not require adding the backend token/Client Secret to the target or redeploying that target. A newly added/changed DSN requires a new target deployment.

The handler path is `/api/webhooks/sentry`. After its production deployment/routing checks pass, follow the [owner-run delivery steps](SENTRY_WEBHOOK.md#tests-and-owner-run-live-check) to set the URL and activate the matching Issue Alert. Preserve the project/tag/release filter and fictional-data constraints. A verified receipt is not queued work or permission to modify/merge code; this slice acknowledges validation only and logs a sanitized receipt.

Official setup references: [internal integration and auth token](https://docs.sentry.io/api/guides/create-auth-token/), [enable an alert action](https://www.sentry.help/en/articles/17443113-how-can-i-enable-webhooks-as-an-alert-action-in-sentry), [issue-update permission](https://docs.sentry.io/api/events/update-an-issue/).

### 2. UI collaborator lane

- [ ] Owner reviews/merges the documentation-only UI-rules PR and invites the collaborator to the existing private demo repository.
- [ ] Collaborator proposes a polished chat-style or other demo concept and improves frontend UX within that brief.
- [ ] Preserve the existing error API and backend/Sentry contracts. Any new scenario requiring another backend interface is agreed separately with the core owner.

No invitation or repository-access change has been made by the agent. UI work does not include the assistant architecture, phone/worker logic, parser repair or deployment orchestration.

### 3. First developer acceptance boundary

- [ ] Selectively reuse the minimal incident-intake, persistence and phone/execution pieces from MVP; do not copy the whole application.
- [x] Prove the fictional upload error appears in Sentry: matching issue and one event are visible in the owner's screenshot.
- [ ] Prove the matching signed alert reaches the approved handler once.
- [ ] Prove one investigation produces real evidence and a useful findings call. Have the owner confirm the call was heard.
- [ ] Use one targeted, owner-run credential-dependent diagnostic if a reused integration blocks this path; share only redacted results.

### 4. Approved developer action and completion

- [ ] Bind fresh approval to the exact repository/action/revision.
- [ ] Execute actual reproduction, edits and regression tests; create the scoped PR.
- [ ] Merge only within the approved scope, with the required checks and expected commit still matching.
- [ ] Verify the actual deployed change, replay the original failing input and deliver an honest success/blocker callback.

The full developer chain is the largest remaining delivery risk. A captured event, queued job, created PR or green general health response alone is not a completed repair.

### 5. Second demo and submission

- [ ] Discuss and agree the small older-adult help/reminder scenario, then reuse the same conversation/task/callback core.
- [ ] Rehearse both selected journeys and a refusal/failure case; record what was prepared, what ran and what remains unverified.
- [ ] Finish setup instructions, reuse/asset credits, public submission links, a working video of at most 90 seconds and a concrete example of Codex's contribution.
- [ ] Confirm the organisers' submission rules. Reserve the final hour before the 17:00 London deadline for rehearsal, recording, checks and submission; aim to submit by 16:45.

The next implementation slice is not authorized by a checked planning item alone. Keep changes small, reviewable and tied to an actual acceptance boundary.

## Gmail contribution in the isolated worktree — 1 November 2026

- Implemented: connections page with Gmail enabled in scope and Calendar, Outlook, Drive, Notion, WhatsApp and Telegram visibly disabled.
- Implemented: Composio managed-auth REST adapter, verified account binding, bounded Gmail read/prepare, approved draft/send, receipt readback and uncertain-send reconciliation.
- Offline checks: `npm run check`; tests use fictional fixtures, not live accounts.
- Pending with shared-core owner: authenticated web/caller identity, durable store and atomic approval claim, HTTPS backend/verifier deployment, Agents API tool wiring, real consent/mailbox/phone acceptance.
- Contract and rehearsal: [Gmail integration handoff](GMAIL_INTEGRATION.md). Existing checklist above describes the main-branch baseline.
