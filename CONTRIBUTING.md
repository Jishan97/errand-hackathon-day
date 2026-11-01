# Working together

We are building two small demonstrations of the same Errand assistant. Start with [the README](README.md), then read [the plan](docs/PLAN.md) and [module boundaries](docs/ARCHITECTURE.md).

## This first structure commit

Implemented: a local Node HTTP shell, `GET /`, `GET /healthz`, normal 404/405 responses, and syntax-check/start commands. Everything under the core, voice, integrations and demo directories is a planning brief. There are no provider clients, saved tasks, phone actions or working demos yet.

`npm run check` and `npm run dev` require no credentials and do not load private dotenv files. The public README contains the full starting commands.

## A suggested two-person split

These are work areas to agree together, not assigned ownership:

| Work area | Likely files | First useful contribution |
| --- | --- | --- |
| Developer journey and execution | `src/demos/developer/`, relevant `src/integrations/` modules | Bring across the smallest reviewed incident/investigation boundary from preparation; show real evidence before adding write actions. |
| Phone experience and everyday demo | `src/voice/`, `src/demos/everyday-help/` | Bring across the smallest reviewed voice boundary; keep ordinary questions possible and refine the older-adult scenario with the owner. |
| Shared core and final rehearsal | `src/core/`, `src/app.js`, `docs/` | Agree the task/approval/result contract first, integrate both paths and record the actual demo evidence. |

Coordinate before changing shared task state, approval semantics, the HTTP entry point or configuration names. Keep scenario-specific code out of the common conversation loop.

## Commit workflow

Pull current `main` before starting. Use short feature branches and small pull requests for concurrent work unless the team agrees otherwise; this initial scaffold is committed directly to `main` at the owner's request. Do not rewrite shared history.

For each slice, describe what works, what remains planned, how it was checked and whether external effects occurred. Review only intended files before staging. Reuse preparation selectively, credit it in the README, and keep real configuration and personal data out of commits.

No service setup needs to be recreated. Live checks are owner-run with private configuration and redacted results. A local check proves its own boundary; it does not prove telephone delivery or a deployed repair.
