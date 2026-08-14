# PLAN-104 — Close review gaps in OpenCode V2 provider (commit 962f67b8)

## Context

Commit `962f67b8` (`feat(opencode): add native v2 provider and form flow`) implemented the
core of PLAN-103 (native v2 client/adapter/provider stack, compat-shim deletion, question
forms). A two-axis review (standards + spec) found correctness bugs, duplicated helpers,
dead code, and PLAN-103 deliverables that were skipped — most notably the M4 integrated
verification and several required tests. This plan closes those gaps. It does not add new
product behavior beyond what PLAN-103 already specified.

All paths below were verified against the current working copy (`@-` = 962f67b8, no
changes on top).

## Goal

- Fix the three correctness bugs (form label→value translation, over-broad projection
  remap, tool-lifecycle mapping drift).
- Deliver the PLAN-103 requirements that were skipped (tool-name recovery, cold-restart
  proof, reactor/driver-meta/UI-path tests, M4 mock service + browser verification).
- Collapse duplicated helpers and dead constants introduced by the commit.

## Implementation status

Completed on 2026-08-14:

- T1-T14 implemented, including paginated projected-message tool-name recovery, the
  file-backed cold-restart re-adoption test, migrated-thread reactor routing, and the
  deterministic HTTP/SSE mock service.
- Focused gate: 12 test files, 194 tests passed.
- Scoped `vp check`: all 24 changed files formatted; no lint warnings or errors.
- Integrated web verification: isolated paired environment with the mock `opencode2`
  instance exercised streamed text, a `bash` tool lifecycle, label/value option mapping,
  a zero-option custom-only answer, form submission, and terminal turn completion.

## Out of scope

- Rewriting `opencodeV2Client.ts` into an Effect-native client. Call sites already wrap it
  in `Effect.tryPromise`; a rewrite is churn without behavior change. (Revisit only if the
  client grows retry/stream logic.)
- Repo-wide provider-registry refactor to eliminate the "new driver touches ≥7 web files"
  shotgun-surgery pattern. Pre-existing structure; deserves its own plan.
- Full `effect/Schema` decoding of every v2 event payload in `OpenCodeV2Adapter.ts`. Per
  decision D3, this plan adds targeted schemas for command-critical payloads (forms,
  permissions, resume cursors, and inventory) while keeping high-volume streaming events
  permissive and forward-compatible.
- `.gitignore` `.opencode/goals/` entry — harmless, keep.

## Milestone 1 — Correctness bugs

### T1: Translate form answer labels back to option values

- Bug: `toOpenCodeV2FormAnswer` (`apps/server/src/provider/Layers/OpenCodeV2Adapter.ts:199`)
  passes web-submitted labels through verbatim. `OpenCodeV2FormField.options` carry distinct
  `value?`/`label?` (`OpenCodeV2Adapter.ts:61-73`), and `mapOpenCodeV2FormToQuestions`
  (`:167`) drops `value` entirely, so any multiselect/string field whose option `value`
  differs from its `label` submits the wrong value. PLAN-103: "the adapter must translate
  labels back to values."
- Modify: `apps/server/src/provider/Layers/OpenCodeV2Adapter.ts`
  - In `toOpenCodeV2FormAnswer`, build a per-field `label → value` map from
    `form.fields[].options` and translate each submitted answer entry (arrays for
    multiselect, scalars for single-select). Unmatched entries (custom free-text answers)
    pass through unchanged.
- Test: extend `apps/server/src/provider/Layers/OpenCodeV2Adapter.test.ts`
  - multiselect field with `{value: "opt-a", label: "Option A"}` → answer `["Option A"]`
    submits `["opt-a"]`.
  - custom free-text answer not matching any option passes through verbatim.
  - option without `value` falls back to label.
- Command: `vp test run apps/server/src/provider/Layers/OpenCodeV2Adapter.test.ts`
- Done when: label/value-distinct fixtures round-trip to values; existing tests green.

### T2: Stop remapping possibly-v1 NULL-instance thread-session rows

- Bug: `apps/server/src/persistence/Layers/ProjectionThreadSessions.ts:110` remaps rows
  matching `provider_instance_id IS NULL AND provider_name = 'opencode'`, while the runtime
  remap deliberately "rewrites only explicitly bound legacy rows"
  (`apps/server/src/persistence/ProviderSessionRuntime.test.ts:13`). NULL-instance rows can
  be true v1 sessions; PLAN-103 requires leaving true v1 rows alone.
- Modify: `apps/server/src/persistence/Layers/ProjectionThreadSessions.ts` — restrict the
  remap predicate to explicitly bound legacy rows, mirroring the
  `ProviderSessionRuntime.ts` predicate. Check `ProjectionThreads.ts` for the same pattern
  and align if present.
- Test: extend `apps/server/src/persistence/ProviderSessionRuntime.test.ts` (or the
  projection-layer test that covers the SQL): a NULL-instance `opencode` row survives
  migration untouched.
- Command: `vp test run apps/server/src/persistence/ProviderSessionRuntime.test.ts`
- Done when: only explicitly bound rows are rewritten in both remap sites; test proves the
  NULL-instance row is preserved.

### T3: Single `toToolLifecycleItemType` shared by both adapters

- Bug: near-duplicate copies with silent drift — `OpenCodeAdapter.ts:356` handles
  `image`/`task` branches, `OpenCodeV2Adapter.ts:212` does not.
- Create: `apps/server/src/provider/Layers/toolLifecycleItemType.ts` (proposed path)
  exporting the superset mapping (including `image`/`task`).
- Modify: `apps/server/src/provider/Layers/OpenCodeAdapter.ts`,
  `apps/server/src/provider/Layers/OpenCodeV2Adapter.ts` — delete local copies, import
  shared helper.
- Test: co-located `toolLifecycleItemType.test.ts` covering every branch, plus existing
  adapter tests unchanged.
- Command: `vp test run apps/server/src/provider/Layers/toolLifecycleItemType.test.ts apps/server/src/provider/Layers/OpenCodeV2Adapter.test.ts`
- Done when: one implementation, both adapters consume it, `image`/`task` inputs map
  identically on both paths.

### T4: Recover tool names from projected messages on adopt

- Gap: PLAN-103:239 — "On adopt without that event, recover name from projected messages";
  adapter falls straight to generic `"tool"` (`OpenCodeV2Adapter.ts:685`:
  `knownName ?? asString(data.name) ?? "tool"`).
- Modify: `apps/server/src/provider/Layers/OpenCodeV2Adapter.ts` — on adoption, seed the
  known-tool-name cache from the session's projected messages (the adapter already receives
  adoption context; wire the projected-message lookup PLAN-103 describes; consult
  `ProjectionThreadSessions`/`ProjectionThreads` services for the read).
- Test: extend `apps/server/src/provider/Layers/OpenCodeV2Adapter.test.ts` — adopt a
  session with a projected tool message and no live name event; emitted lifecycle item uses
  the recovered name, not `"tool"`.
- Command: `vp test run apps/server/src/provider/Layers/OpenCodeV2Adapter.test.ts`
- Done when: adoption path prefers projected names; fallback to `"tool"` only when nothing
  is recoverable.

## Milestone 2 — Deduplication and dead code

### T5: Share `titleCaseSlug`

- Duplicated verbatim: `OpenCodeProvider.ts:145`, `OpenCodeV2Provider.ts:47`.
- Create: put it next to other provider-layer helpers (proposed:
  `apps/server/src/provider/Layers/slug.ts`, or fold into the T3 helper module if a
  combined `openCodeShared.ts` reads better — executor's choice, one module either way).
- Modify both providers to import it. Existing provider tests stay green.
- Command: `vp test run apps/server/src/provider/Layers/OpenCodeV2Provider.test.ts apps/server/src/provider/Layers/OpenCodeProvider.test.ts`

### T6: Share `basicAuthHeader`

- Triplicated: `opencodeV2Client.ts:92`, `opencodeV2Service.ts:170`, inline at
  `opencodeRuntime.ts:837`.
- Create: `apps/server/src/provider/opencodeAuth.ts` (proposed) exporting
  `basicAuthHeader(password: string)`.
- Modify all three call sites to import it.
- Command: `vp test run apps/server/src/provider/opencodeV2Client.test.ts apps/server/src/provider/opencodeV2Service.test.ts`

### T7: Single source for the v2-unavailable reason

- `OPENCODE_V2_UNAVAILABLE_REASON` (`OpenCodeV2Binding.ts:35`) is exported but unused
  anywhere else; `opencodeRuntime.ts` `requireProtocol` carries its own literal.
- Modify: either import the constant in `requireProtocol` (preferred — it is the intended
  single source) or delete the export. No behavior change; message text stays identical.
- Command: `vp test run apps/server/src/provider/Layers/OpenCodeV2Binding.test.ts`

### T8: One provider-key list in the web composer store

- `apps/web/src/composerDraftStore.ts:781` and `:940` repeat
  `["codex", "claudeAgent", "cursor", "opencode", "opencodeV2"] as const`.
- Modify: hoist a single module-level `const COMPOSER_PROVIDER_KEYS` (or reuse an existing
  exported provider-name union from `packages/contracts/src/model.ts` if one enumerates
  exactly these keys — verify before choosing; contracts must stay schema-only, so a
  runtime array belongs in the web module, derived via `Schema` literals only if already
  idiomatic there).
- Test: existing composer tests; add none unless behavior shifts.
- Command: `vp test run apps/web/src/composerDraftStore.test.ts` (verify exact test path
  before running; if no test exists, typecheck scope suffices for this mechanical hoist).

## Milestone 3 — Missing PLAN-103 tests

### T9: Cold-restart re-adoption proof

- PLAN-103:425 — "prove it with a cold-restart test." Only the SQL remap unit test exists.
- Test: extend `apps/server/src/provider/Layers/ProviderService.test.ts` (or a new focused
  file beside it): persist a migrated v2 binding, tear the service layer down, bring up a
  fresh layer against the same store, assert startup recovery re-adopts the session under
  `opencodeV2` with the converted resume cursor.
- Command: `vp test run apps/server/src/provider/Layers/ProviderService.test.ts`

### T10: ProviderCommandReactor migrated-thread routing

- PLAN-103 M1 test list names this explicitly; nothing was touched.
- Test: extend `apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts` — a
  command targeting a migrated thread routes to the `opencodeV2` instance, not `opencode`.
- Command: `vp test run apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts`

### T11: Web driver-meta tests

- Create: `apps/web/src/components/settings/providerDriverMeta.test.ts` — asserts the
  `opencodeV2` entry (icon, display name, settings panel wiring) and that v1 `opencode`
  meta is unchanged.
- Command: `vp test run apps/web/src/components/settings/providerDriverMeta.test.ts`

### T12: Composer/UI-path zero-option custom-only submit

- PLAN-103 M3 requires "a composer/UI-path case for zero-option custom-only submit"; only
  helper-level coverage exists (`buildPendingUserInputAnswers`).
- Test: extend `apps/web/src/pendingUserInput.test.ts` or `apps/web/src/session-logic.test.ts`
  at the UI-path level the plan meant: a question with zero options and custom input
  enabled reaches submit with the typed answer end-to-end through composer state.
- Command: `vp test run apps/web/src/pendingUserInput.test.ts apps/web/src/session-logic.test.ts`

## Milestone 4 — Integrated verification (PLAN-103 M4)

### T13: Deterministic mock v2 service

- PLAN-103:509 — "a deterministic mock v2 service that can emit text, one tool, a question
  form" before browser verification.
- Create: `apps/server/src/provider/opencodeV2Mock.ts` + test-fixture entry point (exact
  shape per PLAN-103 M4 section; proposed path — align with wherever `opencodeV2Service.test.ts`
  fixtures live today).
- Test: drive `OpenCodeV2Adapter`/`opencodeV2Client` against the mock for the scripted
  text → tool → question-form sequence.
- Command: `vp test run apps/server/src/provider/opencodeV2Client.test.ts apps/server/src/provider/Layers/OpenCodeV2Adapter.test.ts`

### T14: Browser verification pass

- Per repo AGENTS.md and PLAN-103 M4: run the `test-shuv2code-app` skill — one isolated
  environment, authenticate through the printed pairing URL, connect an `opencodeV2`
  provider backed by the T13 mock, and verify in the controlled browser: streaming text, a
  tool lifecycle item, the question form (including a zero-option custom-only submit), and
  form answer submission. Stop the dev server afterward.
- Done when: each flow is observed working in the browser; failures loop back into M1–M3
  tasks.

## Validation (overall)

- Per-task focused `vp test run` commands above; no repo-wide suites (AGENTS.md).
- After M1–M3: one combined focused run of every test file touched by this plan.
- After T14: dev servers and watchers stopped.

## Risks

- T2 predicate tightening could strand genuinely-migrated NULL-instance rows if any
  environment already ran the old remap. Mitigation: the remap is idempotent and the old
  broad pass has already rewritten such rows where it ran; new predicate only affects
  future runs.
- T4 (projected-message lookup) adds a persistence read into the adapter adoption path;
  keep it a single bounded query and fail open to `"tool"`.
- T13 mock fidelity: script it from the real v2 SSE shapes already exercised in
  `opencodeV2Client.test.ts` fixtures to avoid testing against an invented protocol.

## Rollback

- Every task is an independent, small commit (jj). Revert any single change with
  `jj backout` of that commit; no task depends on another except T3 before T5 if the
  executor merges them into one shared-helpers module, and T13 before T14.

## Open decisions

## Settled decisions

- **D1 — Keep and harden the SQL migration.** This is a one-time compatibility migration,
  not a durable domain action. Keep each phase idempotent, restrict predicates to explicitly
  v2-bound legacy rows, and prove restart recovery. An orchestration-event migration is out
  of scope.
- **D2 — Retain `opencode2`.** It is the canonical user-facing provider name; `opencodeV2`
  remains the internal driver key. Do not rename presentation strings.
- **D3 — Decode command-critical payloads only.** Add `effect/Schema` decoding for forms,
  permissions, resume cursors, and model/agent inventory. Keep text deltas, tool progress,
  optional metadata, and unknown event variants permissive. Recognized command-critical
  payloads with invalid required fields must fail explicitly instead of fabricating values.
