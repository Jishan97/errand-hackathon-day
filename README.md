# Errand — Hackathon Day

Errand is a phone-based assistant that carries out approved work between calls and calls back with a verified result.

Built for the [DevDay Exchange London Community Hackathon](https://luma.com/dde-ldn-hack) on Sunday, 1 November 2026.

## What we are building

One assistant, two demonstrations, sharing conversation, scoped approvals, saved tasks, background work and callbacks.

| Demo | Who it helps | Intended experience | Priority |
| --- | --- | --- | --- |
| Developer assistant | A developer responsible for a small deployed app | Detect a controlled incident, investigate it, call with findings, obtain approval, prepare and test a fix, deliver the approved change and call back with a verified result. | Main showcase and development priority |
| Everyday phone help | Older adults who prefer asking for help by phone | Call for ordinary help or ask for a reminder; clarify and confirm the request, then receive a callback when appropriate. | Second demo; exact scenario to be discussed |

The assistant should remain conversational. An existing incident or reminder is context, not a reason to force every new question into that task.

## Start here, collaborator

Read the [delivery plan](docs/PLAN.md), [architecture and module boundaries](docs/ARCHITECTURE.md), [contribution guide](CONTRIBUTING.md), and [agent working rules](AGENTS.md). The developer [demo brief](src/demos/developer/README.md) describes the main journey; the everyday-help [outline](src/demos/everyday-help/README.md) deliberately leaves its detailed scenario open.

This commit is the initial structure. It includes a credential-free Node HTTP shell and documented module locations. Voice, AI, storage, incident handling, coding, reminders, GitHub actions and callbacks are not connected yet. Earlier preparation results do not establish that either demo works in this repository.

## Run the scaffold

Use Node.js 24 or later; `.nvmrc` selects Node 24. There are no third-party dependencies or required credentials at this stage.

```sh
git clone https://github.com/Jishan97/errand-hackathon-day.git
cd errand-hackathon-day
npm run check
npm run dev
```

Open [the local overview](http://127.0.0.1:3000/) or [health endpoint](http://127.0.0.1:3000/healthz). Both return JSON. `GET /healthz` confirms only that the scaffold responds; it does not test any integration. Stop with Ctrl-C. `npm start` runs the same shell without watch mode.

These commands do not load dotenv files or call external services. No deployment is configured by this commit.

## Project layout

```text
docs/                     Delivery plan and architecture
src/app.js                HTTP shell: overview, health and honest 404s
src/server.js             Loopback-only local entry point
src/core/                 Shared conversation/task/approval/worker boundaries
src/voice/                Future phone transport and callback adapter
src/integrations/         Future wrappers around existing services
src/demos/developer/      Developer scenario brief
src/demos/everyday-help/  Older-adult phone-help scenario outline
```

The module directories contain briefs rather than fake implementations. Build one small, reviewable slice at a time, with the developer demo receiving most of the effort.

## Repository scope

This is the standalone public source repository for the `hackathon-day/` application, with `main` as its initial branch. Preparation code and learning records remain in the parent Errand workspace. The existing controlled Errand demo repository remains a separate integration target.

Reuse the existing OpenAI, GitHub, Vercel, Supabase, Twilio and other service setup as needed, including the existing GitHub App. Creating this source repository does not create or reconfigure any service or deployment.

## Existing work and credits

Errand's concept exploration, integration experiments and preparation work predate the hackathon build. That preparation is not included in this initial commit. Any code, templates or assets reused in the application will be credited here, with the work completed during the event identified separately.

## Configuration privacy

Credentials and personal data are excluded from this repository. Private dotenv files remain owner-managed and must not be inspected, copied or committed by agents. In the parent Errand workspace, proposed configuration changes belong only in the sanitized `mvp/.env.example` template, with private fields empty.
