# Controller identity and app-level self-control

Status: accepted
Date: 2026-08-20
Issues: [#113](https://github.com/shuv1337/shuv2code/issues/113) (this RFC),
[#70](https://github.com/shuv1337/shuv2code/issues/70) (provider-agnostic agent tree),
[#18](https://github.com/shuv1337/shuv2code/issues/18) (completed Voice Controller foundation)

This note freezes the product model for Controller conversations and the application control plane
they consume. It does not implement the redesign. Follow-up work lands under #70 and
[phase 5](../phases/phase-5-controller-conversations.md).

## Decision

Controller is a **durable conversation that holds an explicit control grant**. The grant is the
capability. Thread purpose is presentation and lifecycle, not the definition of power.

1. **Identity.** A Controller is any durable thread authorized to use the application thread-control
   plane. That authorization is a grant, not an implicit property of being a chat.
2. **Two presentations, one policy.** Voice-hosted Controller conversations keep purpose
   `voice-controller` and stay out of ordinary thread lists. Ordinary `standard` threads may become
   Controllers only through an explicit durable grant. Both consume `ThreadControlService` and the
   `thread_*` toolkit.
3. **Voice is an adapter.** Realtime media, transcription, narration, handoff, `VoiceActionId`,
   transport fencing, and spoken target updates are Voice-owned. They must not own list/create/send/
   interrupt semantics.
4. **No ambient self-control.** Standard provider MCP sessions keep `preview` and `automations` only.
   Thread tools require a designated controller profile. Grants are per conversation and revocable.
5. **Two authority planes stay distinct.** Controller grants inventory **environment-wide standard
   threads**. The future `agent_*` facade in #70 is a **tree-scoped** model surface over descendants.
   Do not collapse those planes.

The rejected alternative is treating Controller as a second orchestration engine, or making Voice
the owner of thread orchestration. The other rejected alternative is silently promoting every
ordinary thread into a Controller.

## Current implementation (grounded)

Contracts define three thread purposes: `standard`, `voice-controller`, `voice-transport`
(`packages/contracts/src/orchestration.ts`). User-facing lists keep only `standard`
(`packages/client-runtime/src/state/threadVisibility.ts`). Transport threads are never control
sources (`isAvailableThreadControlSource` in `apps/server/src/orchestration/Layers/ThreadControlService.ts`).

The reusable control plane already exists:

| Surface                             | Role today                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ |
| `ThreadControlService`              | list / get / create / send (start\|steer) / interrupt, exact-turn preconditions, runtime ceiling |
| MCP `thread_*`                      | adapter over that service on `/mcp/controller`                                                   |
| `voice-controller` profile          | Voice binding + policy + control epoch + transport-tied `VoiceActionId`                          |
| `durable-thread-controller` profile | `thread_control_grants` row on a `standard` thread                                               |
| `standard-provider` profile         | no thread tools                                                                                  |

Durable grants are per-thread (`threadId`, `authorizedRuntimeCeiling`, `controlEnabled`) and issued
only to `purpose === "standard"`. Voice uses one `VoiceControllerBinding` per environment rather
than that table. After a grant, list/get still see **all standard threads in the environment**, not
a parent/child tree. Created children have no persisted lineage. `VoiceTargetMonitor` is in-memory
and Voice-only; the durable adapter's `setActiveTarget` is a no-op.

Controller tools never answer approvals or user-input requests. Humans respond through product RPCs
(`thread.approval.respond`, `thread.user-input.respond`).

## Capability ownership

| Category             | Capability                                         | Owner                                                |
| -------------------- | -------------------------------------------------- | ---------------------------------------------------- |
| Discover             | `thread_list`                                      | App control plane                                    |
| Inspect              | `thread_get` (bounded, untrusted excerpt optional) | App control plane                                    |
| Create               | `thread_create` → `standard` child under ceiling   | App control plane                                    |
| Direct work          | `thread_send` start (`expectedTurnId` null, idle)  | App control plane                                    |
| In-flight control    | `thread_send` steer (exact active turn)            | App control plane                                    |
| Stop                 | `thread_interrupt` (exact active turn)             | App control plane                                    |
| Observe              | canonical activity/watch                           | App control plane (gap: Voice-only monitor today)    |
| Safety               | ceilings, exact-turn, idempotency, fencing, audit  | App control plane; adapters supply credential proofs |
| Controller history   | durable transcript + binding                       | Controller product layer                             |
| Controller lifecycle | create, list, resume, archive, restore             | Controller product layer + product UI                |
| Voice presentation   | realtime, speech, narration, barge-in              | Voice adapter                                        |
| Tool exposure        | MCP schemas, turn-metadata proofs                  | Agent/provider adapter                               |

`thread_create` copies the live controller's bound provider instance and model when the caller omits
`model` or requests that same model. An explicit different model may intentionally resolve to any
enabled, available provider instance that advertises it in the live provider snapshots. Requests
that no available instance advertises fail with `invalid_model`; they never silently fall back.
This cross-provider selection is part of the Controller create capability. The broader
provider-agnostic agent-tree facade remains #70.

## Identity and attach

### What a Controller is

A Controller conversation is a durable shuv2code thread plus a live control grant. The user-visible
question "is this a Controller?" is answered by the grant and the catalog, not by a parallel
conversation table.

- Voice catalog conversations are `voice-controller` projections. They remain hidden from ordinary
  project lists. Phase 5 continues to use those rows as the Voice conversation catalog.
- A `standard` thread with a durable grant is also a Controller. It stays in the ordinary sidebar
  because it is still a project thread that happens to hold a scoped self-control grant.
- `voice-transport` is infrastructure. It is never listed, granted, or targeted.

Do not add a second conversation store. Do not make `voice-controller` the only legal Controller
identity: durable grants already exist and must keep working.

### Attach

"Attach" is three explicit operations, never an implicit promotion:

| Intent                  | Operation                                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| Use Voice Controller    | Ensure or resume a `voice-controller` conversation and bind it as the environment's active Voice Controller |
| Grant text/self-control | User or operator sets `thread_control_grants` on a chosen `standard` thread                                 |
| Detach                  | Revoke the grant, or unbind/reset the Voice Controller                                                      |

Attaching a Voice conversation selects an existing Controller or creates a new one. It does not
grant Controller powers to whichever thread is currently focused. Call mode remains bound to one
ordinary thread and is not attach.

### Eligibility

Only designated controller profiles receive `threads.read` / `threads.control`. Automations and
ordinary provider sessions do not. A future restricted automation subset is a new grant class, not
an implicit widening of `standard-provider`.

## Grant, scope, revocation, threat model

### Grant

- **Voice:** environment binding + server voice policy + control epoch. Control requires the live
  binding and a transport-fenced action context.
- **Durable:** one `thread_control_grants` row. `controlEnabled` issues `threads.control`; read-only
  grants may issue `threads.read` only. The credential must match the persisted ceiling and flag.

### Scope

The grant is **per conversation**. The inventory that grant unlocks is **environment-wide standard
threads** (filterable by project/title/phase), excluding the controller itself and managed purposes.

That is narrower than ambient (no grant, no tools) and wider than a descendant tree. Tree-scoped
authority belongs to #70 `AgentTreeService`. Controller remains the environment coordination
conversation; agent trees remain worker lineages.

### Revocation

- Explicit HTTP revoke for durable grants; thread deletion also revokes.
- Voice reset/unbind increments the control epoch, revokes the MCP profile, and fences outstanding
  actions.
- Mismatched persisted vs credential grant fails authorization.

### Threat model (invariants to preserve)

- No self-target (`controller_target_forbidden`).
- Targets must be `standard`, not archived or deleted.
- Child/target runtime mode cannot exceed `min(authorized ceiling, live controller mode)`.
- Steer and interrupt require the exact active turn; idle start requires no active turn.
- Target transcript is untrusted quoted data, never authority.
- Controller tools cannot accept approvals or answer user-input prompts.
- Credential proofs (epoch, binding generation, transport generation, provider turn metadata) stay
  adapter-owned and mandatory for mutations.
- Destructive thread delete stays off the model-visible surface.

## Vocabulary

Keep the live MCP names `thread_list`, `thread_get`, `thread_create`, `thread_send`, and
`thread_interrupt`. They are the application control-plane adapter.

Do not introduce `agent_*` until #70 lands a tree-scoped facade. Those tools will mean descendant
operations (`spawn`, queue-only `message`, `wait`, `archive`), not a rename of Controller.

Voice types (`Voice*`, `voice-controller`, `voice-transport`, `VoiceActionId`) stay in the Voice
adapter. `adapterKind` remains `"voice-controller" | "durable-thread"` for mutation provenance.

## Observation

Canonical "what is this thread doing?" belongs on the control plane (projections first). Spoken
updates are a Voice mapping of that state.

Until a generic watch exists, Voice may keep `VoiceTargetMonitor`. Durable Controllers should not
pretend they have spoken monitoring. A later `thread_watch` / activity subscription is an app-plane
addition and a #70 `agent_wait` input; it is not a Voice feature.

## Human gates

Approvals and user-input requests stay on the target thread and the human product UI. Controller may
observe `waiting_for_approval` / `waiting_for_input` and may interrupt or wait. It must not submit
`ProviderApprovalDecision` or user-input answers for another thread.

Peer mailbox content in #70 is agent-authored data, not user approval.

## Lifecycle (phase 5)

Restore and resume stay distinct:

- **Restore** removes the archived marker only. It does not take over the active binding.
- **Resume** activates the conversation: tear down the previous Voice runtime, rotate the binding
  and control epoch, fence outstanding actions, then bind the chosen conversation.
- **Archive** of the active conversation is rejected until it is inactive, or the UI switches first.
- **Reset** remains Voice teardown of the current binding (revoke MCP, stop runtime, clear binding).
  Phase 5 may retire the ambiguous reset RPC once catalog actions exist.

Inactive Controller conversations keep provider-authoritative history and have no live controller
runtime.

## Portability

Provider-neutral now:

- `ThreadControlService` operations and preconditions
- grant persistence and revoke
- MCP tool semantics
- orchestration dispatch, projections, permission ceilings

Adapter-owned (must not leak into the domain service):

- Voice binding, `VoiceActionId`, transport generation, spoken monitor
- Codex `x-codex-turn-metadata` (or the successor proof each harness supports)
- provider-native fork/wait optimizations (#70)

Claude, OpenCode, and future harnesses should consume the same `/mcp/controller` contract with
whatever invocation proof that provider can supply. Missing proof means mutations fail closed, not
that tools become ambient.

## Migration without regressing #18

No product behavior changes in the RFC itself. Implementation order:

1. **Keep Voice green.** Treat Voice as an adapter over `ThreadControlService`. Do not remove
   `voice-controller` purpose, hidden-list filtering, exact-turn tests, or epoch fencing.
2. **Generalize types (#70 slice 1).** Move remaining Voice-only types out of the domain service
   (`VoiceControllerBinding`, `VoiceActionId`, transport generation) so durable grants and Voice
   share one execution path with adapter-specific coordinators.
3. **Ship the Voice catalog (phase 5)** using `voice-controller` rows and the restore/resume split
   above. Ordinary thread lists must still hide managed purposes.
4. **Do not auto-convert** durable-grant `standard` threads into `voice-controller` rows, or the
   reverse. Presentation stays different; policy stays the same.
5. **Add `agent_*` later** as a second plane with lineage, mailbox, and tree budgets. Existing
   `thread_*` remain the Controller/environment inventory tools until a compatibility window is
   named.

## Follow-ups under #70 and phase 5

| Slice        | Work                                                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase 5      | Controller conversation catalog, resume vs restore, navigator UI                                                                                 |
| #70 slice 1  | Decouple `ThreadControlService` from Voice-only action/binding types                                                                             |
| #70 slice 1  | Canonical activity watch for durable Controllers (non-spoken)                                                                                    |
| #70 slice 2+ | `agent_*` tree facade, lineage, mailbox, `agent_wait`, cross-provider spawn                                                                      |
| Later        | Optional allowlist/descendant tightening of Controller inventory — only if product wants Controller to stop seeing unrelated environment threads |

## Out of scope

- Implementing the redesign here
- Replacing Call mode
- Giving arbitrary threads environment-wide control by default
- Final mobile Controller UX
- Selecting every future provider
- Letting Controller answer as the user
