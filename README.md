# Errand — Hackathon Day

Errand is a phone-based assistant that carries out approved work between calls and calls back with a verified result.

Built for the [DevDay Exchange London Community Hackathon](https://luma.com/dde-ldn-hack) on Sunday, 1 November 2026.

Production URL: [Errand on Vercel](https://errand-hackathon-day.vercel.app).

## What we are building

One assistant, two demonstrations, sharing conversation, scoped approvals, saved tasks, background work and callbacks.

| Demo | Who it helps | Intended experience | Priority |
| --- | --- | --- | --- |
| Developer assistant | A developer responsible for a small deployed app | Detect a controlled incident, investigate it, call with findings, obtain approval, prepare and test a fix, deliver the approved change and call back with a verified result. | Main showcase and development priority |
| Everyday phone help | Older adults who prefer asking for help by phone | Call for ordinary help or ask for a reminder; clarify and confirm the request, then receive a callback when appropriate. | Second demo; exact scenario to be discussed |

The assistant should remain conversational. An existing incident or reminder is context, not a reason to force every new question into that task.

## Start here, collaborator

Read the [current checklist](docs/CHECKLIST.md), [delivery plan](docs/PLAN.md), [architecture and module boundaries](docs/ARCHITECTURE.md), [contribution guide](CONTRIBUTING.md), and [agent working rules](AGENTS.md). The developer [demo brief](src/demos/developer/README.md) describes the main journey; the everyday-help [outline](src/demos/everyday-help/README.md) deliberately leaves its detailed scenario open.

The current implementation is deliberately small: a public web page, Vercel deployments from GitHub and a [signed Sentry alert receiver](docs/SENTRY_WEBHOOK.md) adapted from MVP work. Matching alerts return a validation receipt explicitly marked `processing: not_connected`. Voice, AI, storage, investigation, coding, reminders and callbacks are not connected yet. Earlier preparation results do not establish that either full demo works in this repository.

## Run the scaffold

Use Node.js 24; `.nvmrc` selects that version. There are no third-party dependencies. Local preview and offline tests need no credentials; deployed webhook verification uses the owner's existing Sentry configuration.

```sh
git clone https://github.com/Jishan97/errand-hackathon-day.git
cd errand-hackathon-day
npm run check
npm test
npm run dev
```

Open [the local web page](http://127.0.0.1:3000/) or [health endpoint](http://127.0.0.1:3000/healthz). The page describes the two planned demos; health returns JSON reporting `servicesConnected: false`. It does not test any integration. Stop with Ctrl-C. `npm start` runs the same local server without watch mode.

These commands do not load dotenv files or call external services. Vercel publishes `public/` alongside `api/webhooks/sentry.js`; the local server adapts requests to the same verifier with empty configuration by default. The production build runs syntax checks and all offline tests before publishing.

## Project layout

```text
docs/                     Delivery plan and architecture
public/                   Small web page, stylesheet and static health JSON
vercel.json               Static output, function settings, health route and checks
api/webhooks/sentry.js     Vercel Web Request entry point
src/app.js                Local public-file server and webhook adapter
src/server.js             Loopback-only local entry point
src/core/                 Shared conversation/task/approval/worker boundaries
src/voice/                Future phone transport and callback adapter
src/integrations/         Signed Sentry verifier and future service wrappers
tests/                    Credential-free webhook and HTTP regression checks
src/demos/developer/      Developer scenario brief
src/demos/everyday-help/  Older-adult phone-help scenario outline
```

The remaining module directories contain briefs. Build one small, reviewable slice at a time, with the developer demo receiving most of the effort.

## Repository scope

This is the standalone public source repository for the `hackathon-day/` application, with `main` as its initial branch. Preparation code and learning records remain in the parent Errand workspace. The existing controlled Errand demo repository remains a separate integration target.

Reuse the existing OpenAI, GitHub, Vercel, Supabase, Twilio and other service setup as needed, including the existing GitHub App. The hackathon web project uses the existing Vercel account and GitHub connection. Existing MVP/demo deployments stay in place. The controlled demo sources stay under `mvp/` in the parent workspace; do not move them into this repository.

## Existing work and credits

Errand's concept exploration, integration experiments and preparation work predate the hackathon build. The signed receiver reuses the pre-event MVP's HMAC verifier, demo-event filters and incident digest. The Vercel adapter, bounded streaming input, validation-only response and regression tests were added during the event. Codex adapted that code and executed the tests. No other preparation implementation, external assets or templates were copied in this slice.

## Configuration privacy

Credentials and personal data are excluded from this repository. Private dotenv files remain owner-managed and must not be inspected, copied or committed by agents. In the parent Errand workspace, proposed configuration changes belong only in the sanitized `mvp/.env.example` template, with private fields empty.
