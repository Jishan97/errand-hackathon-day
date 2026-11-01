# Hackathon-day working rules

## Current scope

Build Errand in this repository. The owner confirmed two demos: developer incident assistance as the main showcase, and everyday phone help/reminders for older adults. Use one shared conversation and execution core. The everyday scenario's details remain open for a later discussion.

Read [the plan](docs/PLAN.md) and [architecture](docs/ARCHITECTURE.md) before changing behavior. The current milestone is an initial structure, not the whole product. Take subsequent implementation in small reviewable slices. Do not treat the full roadmap as an instruction to implement every feature at once.

Retain the existing Node/JavaScript direction and reuse existing OpenAI, GitHub App, Vercel, Supabase, Twilio and other service setup. The existing controlled demo repository remains the integration target; this repository is Errand's source. Do not create replacement credentials, services or demo repositories as routine setup. Revalidate the relevant official API documentation when implementing an integration, and preserve the owner's chosen models.

## Private configuration

- Never open, read, parse, source, display, copy, create, edit, overwrite or delete a real dotenv file, including private `.env.*` variants. Do not check their presence or inspect them indirectly through logs, screenshots, scripts or environment dumps.
- Never load them with dotenv, `--env-file`, shell sourcing or `vercel env pull/run`. The owner runs credential-dependent checks and shares only redacted results.
- In the parent Errand workspace, the only approved configuration template is `mvp/.env.example`. Show proposed additions there with explanatory comments and empty credential/personal-data fields. A standalone clone does not include that template; coordinate proposed setting names with the owner rather than creating private files.
- Keep secrets, real phone numbers, transcripts and private account/call identifiers out of source, fixtures, prompts, commits and demos. Use explicit safe paths for searches and staging; never recursively stage the parent workspace.

## Action and evidence boundaries

Phone conversation does not itself authorize external writes. Bind approval to the exact task, target, action and current revision. Keep work durable after hangup; prevent duplicate effects and reconcile uncertain results before retrying.

Use only the selected personal demo repository. Code writes and merging need their own explicit scope, current commit checks and executed tests. Confirm the actual deployment and repeat the failing example before claiming a repair. A model's message, queued job or green health endpoint is not a completed outcome.

Keep ordinary conversation available while tasks are pending. Do not invent a provider result or build a successful-looking stub for an unimplemented feature.

## Collaboration and learning

This directory has independent Git history. Run Git commands here, review explicit staged paths, and use small commits. Coordinate shared-core changes with the human collaborator and never force-push over their work.

Keep the public README and plan accurate about implemented versus planned behavior. Record meaningful decisions and test evidence. When working in the parent Errand workspace, also update its relevant lesson, `mvp/lessons/README.md`, `CURRENT_PLAN.md` and both established Notion plans under the parent instructions. Never publish private preparation records to satisfy that synchronization rule.
