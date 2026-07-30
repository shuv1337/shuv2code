# Development log

## 2026-07-30 — Project automations checkpoint

- Added project-scoped scheduled and manual automations with persisted schedules and run history.
- Added scheduler execution, overlap policy, model/runtime selection, WebSocket RPCs, authorization scopes, and an MCP automation toolkit.
- Added the Automations settings route and client state for creating, editing, running, pausing, and deleting automations.
- Verified the database migration and authenticated Automations route in an isolated live environment; formatting, lint, and affected client/shared type checks pass.
- Focused tests are present, but the current Vite+ runner fails before collecting any suite (`runner.config` is undefined). Server type checking also retains unrelated pre-existing errors in local desktop attach and replay-event tests.
- Remaining work: render image content returned by model tools directly in the chat timeline. Browser-profile and Tailnet proxy changes remain separate from this checkpoint.

## 2026-07-30 — Project automations final audit

- Audited the feature in three independent lanes: code/safety, scope/spec, and tests.
- Fixed scheduler startup ordering so due work cannot dispatch before orchestration reactors subscribe; added a scoped clock-driven scheduler lifecycle test.
- Enforced monotonic MCP permissions for create, enable/update, and run-now operations, generalized capability errors, marked durable MCP creation destructive, and added real capability/project-delegation tests.
- Made automation updates transactional and deletion atomic with active-run admission, preventing resurrection and delete/run races.
- Removed the 60-second missing-turn failure heuristic so slow but valid provider startup is not misclassified.
- Added user documentation for host-running, downtime, missed-run, overlap, deletion, and unattended-permission semantics, plus an in-product full-access warning.
- Focused verification: 11 files and 51 tests passed through direct Vitest. The affected contracts, client-runtime, and web packages typecheck; server typecheck has no automation errors and remains blocked only by pre-existing `localDesktopAttach` and replay-test failures.
- Re-verified migration 35 and the authenticated Automations route in a fresh isolated environment. Product-native preview actions failed at the preview transport after navigation, so the earlier successful real automation run remains the end-to-end CRUD/run evidence for this change.
