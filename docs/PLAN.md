# Two-demo delivery plan

Image demo pivot (isolated branch): the owner selected phone-described image → spoken approval → web display/download as the smaller everyday demo. See [IMAGE_DEMO.md](IMAGE_DEMO.md). Phone routing, image generation and the protected web screen are implemented; owner activation/migration and live acceptance remain pending. Gmail work stays in its existing branch.

> **Current build — 1 November 2026:** The owner has authorized the controlled repair and completion-call flow. See [FAST_INCIDENT.md](FAST_INCIDENT.md) for the implemented path, owner activation and live acceptance checkpoints. Earlier validation-only/static descriptions below are historical. The receiver still returns `not_connected` when the new feature switch is off.

## Immediate next step — 1 November 2026

Follow the [reconciled checklist](CHECKLIST.md) for current status and owners. The web foundation/pipeline is live, Sentry capture in the separate demo has passed, and the owner reports saving updated main-backend credentials. Reuse existing service setup. The owner now authorizes one small signed-webhook receiver, tests and deployment; larger provider wiring remains pending.

The owner asked to reduce the immediate scope: get a minimal web page live with a Vercel pipeline, then slowly select useful work from MVP. The two-demo direction remains; the larger roadmap below is future work. Keep existing demos under MVP with their current GitHub/deployment links.

The current slice adds the [signed Sentry verifier](SENTRY_WEBHOOK.md), a Vercel function, bounded raw-body handling and offline tests, reusing the MVP's HMAC/demo filters. It returns a verification receipt marked processing not connected. No voice, storage, coding worker or reminder integration is brought across. See [deployment and verification](DEPLOYMENT.md).

## Decision — 1 November 2026

The owner confirmed two demonstrations. The developer demo receives most of the attention; the second serves older adults calling for everyday help or a reminder. Its exact scenario will be discussed later. Both use the same assistant and execution core.

This supersedes the generic prompt's single-demo suggestion. It does not expand the hackathon into a multi-user platform or authorize implementing the entire roadmap in this commit.

## The intended experiences

### Developer assistant — primary

Use the existing controlled demo app/repository and the prepared upload incident scenario. The target journey is:

1. A real controlled upload failure is reported through the existing Sentry integration.
2. Errand investigates relevant code/error evidence and calls the developer with findings.
3. The developer requests a fix and explicitly approves its bounded scope.
4. The coding worker reproduces the issue, edits code, runs a regression test and prepares a PR.
5. Only the approved scope permits a merge, with checks passing on the expected commit and repository. A changed head or failed check blocks it.
6. Errand verifies the deployment containing that change and replays the original upload.
7. It calls back with verified success or a specific blocker.

This is the planned end-to-end demonstration, not behavior implemented by the scaffold. Reuse the existing GitHub App and demo repository. Keep the earlier prepared rollback/unmerged-PR experiment clearly distinguished from actual generated code and executed tests.

### Everyday phone help — secondary

An older adult can call and ask an ordinary question or request a simple reminder, without using a web app. A reminder is one optional tool. The assistant clarifies the request and time, obtains confirmation, saves the work and calls when due after the first call has ended.

Use a consenting test caller and fictional everyday content, such as watering plants. Keep the voice clear and patient; allow unrelated questions while a task exists. The exact help/reminder scenario, wording and follow-up behavior remain open for the promised later discussion. Do not add broad care, family-account or complex recurring-schedule features in this scaffold.

## Shared foundation

Conversation → clarify → exact action approval → saved task/job → background execution → outcome verification → callback or honest blocked status.

Task state must survive hangup. Approval is scoped to the current task/action/revision, and uncertain provider outcomes require reconciliation before retrying. Never announce a saved or completed action solely because the model said so.

Retain the established Node/JavaScript approach and existing OpenAI, Twilio, Supabase, GitHub, Sentry and Vercel setup as needed. The owner reports setup is ready; that report is different from a new end-to-end test. No credentials or deployment configuration are introduced by this structure commit.

## Small commits in order

| Slice | Concrete result | Status |
| --- | --- | --- |
| 0. Shared starting point | Collaborator brief, module layout and credential-free HTTP shell | Implemented in this scaffold |
| 0a. Minimal web delivery | Small public page, Vercel build/check and main-branch deployments | Live and verified |
| 0b. Signed Sentry delivery boundary | Reused verifier, validation-only receipt, offline tests and deployment | Implemented; real signed delivery acceptance pending |
| 1. Shared phone/task spine | Reuse reviewed voice, context, approval and durable-work boundaries from preparation | Planned |
| 2. Developer investigation | One selected incident produces useful findings from real evidence | Planned; primary focus |
| 3. Developer action and result | Scoped approval, actual coding/tests/PR, allowed delivery and replay-backed callback | Planned |
| 4. Everyday help/reminder | Agree the small scenario, then demonstrate it on the shared core | Outline; detail pending |
| 5. Rehearsal and submission | Public README/setup/credits, working links, at most 90-second video and a concrete Codex contribution | Pending |

Keep both demo paths visible during integration. Do not build separate agents with duplicate storage or make a pending developer task the assistant's permanent personality.

## What will count as a working demo

For the developer case, retain the actual failing input, investigation, scoped approval, before/after executed test evidence, PR/check/commit references, deployed source verification and successful replay before claiming a repair. Verify the result callback was heard. A green general health endpoint alone is insufficient.

For the everyday case, verify that an ordinary question remains possible, an approved request persists after hangup, and the correct callback is heard. Agree any correction/cancellation behavior when refining the scenario. Refusal must not trigger an action, and repeated events/jobs must not duplicate effects.

All these checks remain pending in hackathon-day. Historical preparation passes keep their original scope.

## Time and delivery risk

The developer flow crosses several services and is the main deadline risk. Prove each boundary before stacking the next one on top. Report the last proven boundary and one useful next check when blocked; do not replace a failed real path with a successful-looking simulation.

At each next slice, use the actual remaining London time before the 17:00 submission deadline. Reserve the final hour for feature freeze, rehearsal, README/credits, recording and public-link checks; aim to submit by 16:45. Confirm the organisers' submission instructions and treatment of pre-existing work. Retain the second demo's deliberately small scope.

## Codex and credits

Record Codex's actual contribution with commits and test evidence. This scaffold is the first application-structure contribution. The runtime developer demo should demonstrate real coding execution, not merely a convincing description of a fix. The existing OpenAI coding-worker integration is a preparation reference to revalidate before reuse; no provider API is instantiated here.

Current official references: [Codex and code generation](https://developers.openai.com/api/docs/guides/code-generation) and [Agents API overview](https://developers.openai.com/api/docs/guides/agents-api/overview). Recheck the relevant request/tool contracts when implementing; retain the owner's selected models and existing credentials.

Credit pre-event concept work, integration experiments and any copied code/assets in the public README. This commit does not copy the preparation application.
