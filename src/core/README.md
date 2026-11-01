# Shared core — planned

Both demos will use this core. Reuse reviewed preparation pieces for conversation/context, task selection, scoped approval, durable tasks/jobs and worker execution.

Keep conversation independent of a task's execution state. A caller can ask a new question while a reminder or incident is pending. A model proposes actions; application validation and a saved approval authorize effects.

Agree the minimal task/approval/result contract with the collaborator before adding modules. Preserve current revisions, deduplicate effects and record uncertain outcomes for reconciliation. No dispatcher, schema or worker is implemented here yet.

See [architecture](../../docs/ARCHITECTURE.md) and [the staged plan](../../docs/PLAN.md).
