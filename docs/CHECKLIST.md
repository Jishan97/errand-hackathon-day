# Where we are and what is left

Reconciled on 1 November 2026. The immediate direction is a small live web foundation, then selective reuse of MVP work. Two demos remain the goal: developer incident assistance first, everyday phone help/reminders for older adults second.

## Done

- [x] Public hackathon source repository, with work pushed to `main`.
- [x] [Minimal web page live](https://errand-hackathon-day.vercel.app) without sign-in.
- [x] Native GitHub → Vercel production pipeline. A normal subsequent push produced a READY deployment, not just a one-off upload.
- [x] Page, CSS and static `/healthz` content verified anonymously against committed files.
- [x] Local syntax, HTTP, asset/document-link and browser checks for this web foundation.
- [x] Initial collaborator brief, architecture boundaries and staged plan.
- [x] UI-only instructions written for the existing developer demo and published as a single-file draft PR in its private repository. The PR is not merged yet.
- [x] Existing demo source stays under MVP; its repository and deployment connections remain in place.

## Existing setup to reuse

| Component | Preparation status | What the new hackathon app still needs |
| --- | --- | --- |
| GitHub | Existing App/demo setup is owner-confirmed. Source pushes and Vercel Git delivery are directly verified. | Wire the reviewed, scoped runtime repository tools when the developer slice needs them; then test that actual path. |
| OpenAI / GPT Live | Existing API/voice setup is owner-confirmed; preparation records include provider and real-call evidence. No replacement keys are requested. | Bring over the minimal voice/reasoning/coding integration and run its relevant acceptance check. |
| Twilio | Existing incoming/outgoing phone preparation is recorded. | Connect the selected conversation/callback path to the new app. |
| Supabase | Existing service setup and preparation contracts are available. | Reuse only the task/approval/job storage needed for the selected slice. |
| Sentry | Owner reports the demo monitoring project's DSN has been obtained; no value was shared or inspected. | Privately save the DSN on the existing demo's Production deployment and redeploy; obtain the separate backend integration settings, then prove one real event and signed delivery. |

Existing account readiness is different from end-to-end acceptance in this new app. At present, the hackathon site serves static files and has no live provider clients, webhook handler, phone bridge, worker, coding action or reminder scheduler. Do not re-provision the existing integrations or reopen old setup failures without new evidence.

## Next, in order

### 1. Owner: Sentry account and monitoring project

The Node.js demo application already exists. A **Sentry project** is its error-monitoring container inside Sentry's dashboard, not another Node app or Git repository. Choose Node.js as that monitoring project's platform because the existing demo backend runs on Node; the existing source already includes the Sentry SDK.

For this demonstration, one monitoring project for the **existing demo app** is enough:

| Application | Role in the Sentry flow | Setup needed |
| --- | --- | --- |
| Existing demo under `mvp/demos/developer/` | Reports the planted error to Sentry. | Existing Sentry SDK plus the demo project's `SENTRY_DSN`. |
| Main app in `hackathon-day/` | Receives signed Sentry alerts and coordinates the approved Errand response. | A backend webhook receiver, verification secret, project/org binding and scoped API token. It does not need its own monitoring DSN/SDK for this role. |

Monitoring errors inside Errand itself is optional later work and can use a separate Sentry monitoring project. It is not required to demonstrate the controlled target's failure. The main app is currently static; its receiver still needs to be brought across and verified before activating the alert.

- [x] Owner reports obtaining the existing demo's DSN after the monitoring-project setup. No new Node app, repository or deployment is required; the private value was not shared or inspected.
- [ ] Get its DSN and privately set `SENTRY_DSN` in the **existing demo site's** Vercel Production settings; redeploy that demo through the owner's normal workflow.
- [ ] Record the demo project's numeric ID and organization slug privately.
- [ ] Create an internal integration for the eventual signed Issue Alert delivery and API access. Enable its Alert Rule Action. The existing implementation expects a webhook Client Secret and an organization token with the issue-write permission used to resolve the incident.
- [ ] Apply the settings below privately, using the existing sanitized template in the parent workspace. Do not paste any values into chat or source control.

| Existing setting name | Destination/purpose |
| --- | --- |
| `SENTRY_DSN` | Demo-site Production only: send the fictional error to the dedicated project. |
| `SENTRY_PROJECT_ID` | Errand backend: allowlist the correct numeric Sentry project. |
| `SENTRY_ORG_SLUG` | Errand backend: scope Sentry API operations to the right organization. |
| `SENTRY_WEBHOOK_SECRET` | Errand backend: the integration Client Secret for verifying signed webhook bytes. |
| `SENTRY_AUTH_TOKEN` | Errand backend: the internal integration token for the approved issue API operations. |

These names already exist in `mvp/.env.example` in the parent workspace. No new credential names or template changes are needed. Keep `ENABLE_INCIDENT_DEMO` disabled until the intended backend, migration and rehearsal prerequisites are ready.

Do not point the alert at the new static website yet: `/api/webhooks/sentry` is not implemented there. The core owner must confirm the intended deployed handler before the Issue Alert is activated. Preserve the existing project/tag/release filter and fictional-data constraints; an alert is not permission to modify or merge code.

Official setup references: [internal integration and auth token](https://docs.sentry.io/api/guides/create-auth-token/), [enable an alert action](https://www.sentry.help/en/articles/17443113-how-can-i-enable-webhooks-as-an-alert-action-in-sentry), [issue-update permission](https://docs.sentry.io/api/events/update-an-issue/).

### 2. UI collaborator lane

- [ ] Owner reviews/merges the documentation-only UI-rules PR and invites the collaborator to the existing private demo repository.
- [ ] Collaborator proposes a polished chat-style or other demo concept and improves frontend UX within that brief.
- [ ] Preserve the existing error API and backend/Sentry contracts. Any new scenario requiring another backend interface is agreed separately with the core owner.

No invitation or repository-access change has been made by the agent. UI work does not include the assistant architecture, phone/worker logic, parser repair or deployment orchestration.

### 3. First developer acceptance boundary

- [ ] Selectively reuse the minimal incident-intake, persistence and phone/execution pieces from MVP; do not copy the whole application.
- [ ] Prove one fictional error appears in Sentry and reaches the approved signed handler once.
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
