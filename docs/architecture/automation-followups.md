# Automation lifecycle follow-ups

Status: discussion draft. This document records unresolved product and lifecycle choices found during review of project automations. It does not define accepted behavior yet. Controller identity and thread-control grants are decided in [Controller identity](./controller-identity.md); automations do not receive those tools by default.

## Decisions at a glance

| Area                | Decision needed                                                                  | Suggested starting point                                                                                               |
| ------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Archived threads    | What happens when an automation-owned thread is archived before its run settles? | Block archive while a run is active; retain archived terminal threads as run history.                                  |
| Missing turns       | How does a run recover when its thread exists but no turn becomes visible?       | Persist dispatch progress and surface a recoverable `stalled` state instead of inferring failure from a short timeout. |
| Default permissions | Which runtime mode should a newly created automation select?                     | Make the choice explicit in the creation flow and default to the project's configured automation mode when one exists. |
| Telemetry           | Which lifecycle transitions and dimensions are safe and useful to record?        | Trace every transition with run-scoped identifiers; keep metrics low-cardinality and prompts out of telemetry.         |

## Archived automation threads

Automation runs use normal conversation threads for execution and history. The normal thread list can hide archived threads, which makes an archived in-flight run look indistinguishable from a missing thread during recovery.

Options:

1. Treat archiving as cancellation. Archiving an active automation thread terminates its run and records an explicit reason.
2. Block archiving while the run is queued or running. Once terminal, the thread can be archived without affecting run history.
3. Let archiving be presentation-only. Automation reconciliation reads archived and active thread projections alike.

Suggested behavior combines options 2 and 3: block the ordinary archive action while a run is active, but make recovery capable of reading an archived thread so external or older clients cannot strand a run. A terminal run should continue linking to its archived thread.

Questions for review:

- Should an administrator or destructive-action flow be able to force archive and cancel in one action?
- Should archived automation threads appear in automation history even when hidden from the main conversation list?
- Is `cancelled` a distinct terminal run status, or is this represented as `failed` with a structured reason?

## Threads with no visible turn

A queued run can durably record its thread before the provider turn is projected. A fixed timeout risks failing a valid but slow provider startup; no timeout can leave overlap policy pinned indefinitely.

The lifecycle should distinguish at least these durable phases:

1. run claimed
2. thread accepted
3. turn accepted
4. provider activity observed
5. terminal result observed

Suggested behavior:

- Make thread and turn dispatch idempotent and persist their accepted command sequence or receipt.
- Retry only the missing phase after restart.
- After a configurable observation window, mark the run `stalled` without discarding it or creating a second thread.
- Let the user retry the missing phase, cancel the run, or open the thread for diagnosis.
- Define whether `stalled` blocks a skip-policy automation. The safer default is yes until a user cancels or retries it.

Questions for review:

- Should `stalled` be a stored run status or derived from timestamps and dispatch phase?
- What is the initial observation window, and should providers override it?
- Can retry reuse the same command identifiers safely across every provider adapter?

## Default runtime permissions

An unattended automation cannot answer approval prompts, while full access permits commands and file changes without a person present. A universal default therefore encodes a product risk decision rather than a neutral UI choice.

Options:

1. Default to full access, keep new automations paused, and require a clear warning before enabling.
2. Default to supervised access and explain that runs may wait for approval.
3. Inherit an explicit project-level automation default, requiring the user to choose one when the project has no default.
4. Remember the last choice locally as a convenience, while still showing it in the creation form.

Suggested behavior is option 3, with option 2 as the fallback until project defaults exist. Enabling an automation should summarize the effective runtime mode and require deliberate confirmation when it is broader than the current conversation's authority. MCP callers must remain unable to create or update an automation beyond the invoking thread's permission ceiling.

Questions for review:

- Is a project-level default worth adding now, or should creation always require an explicit choice?
- Should supervised runs wait indefinitely, become `stalled`, or fail when approval is required?
- Does full access need a second confirmation only on enable, or on each material permission increase?

## Lifecycle telemetry

Automation failures span scheduling, durable dispatch, provider startup, and terminal reconciliation. Telemetry should locate the failed phase without storing prompts or introducing high-cardinality metric labels.

Suggested trace spans or events:

- `automation.run.claimed`
- `automation.thread.accepted`
- `automation.turn.accepted`
- `automation.run.running`
- `automation.run.completed`
- `automation.run.failed`
- `automation.run.stalled`
- `automation.run.skipped`

Trace attributes may include run, automation, project, thread, provider, trigger, concurrency policy, runtime mode, transition source, and structured failure code. Prompts, generated content, project paths, and automation names should not be recorded.

Suggested low-cardinality metrics:

- run transition counter by terminal status, trigger, provider type, and concurrency policy
- claim-to-dispatch and dispatch-to-terminal duration histograms
- current queued, running, and stalled run gauges
- skipped-run counter by structured reason

Run, automation, project, and thread identifiers belong in traces only, not metric labels.

Questions for review:

- Which identifiers are acceptable in the local trace file and remote OTLP export?
- Are lifecycle events emitted from the service transition, the store transaction, or both with deduplication?
- What retention or redaction policy should apply to structured provider errors?

## Implementation boundary

Once these choices are accepted, implementation should include schema migrations where needed, focused state-transition and restart-recovery tests, UI copy for any new status or confirmation, and observability assertions. Until then, this draft intentionally makes no runtime behavior changes.
