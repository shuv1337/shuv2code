# Development log

## 2026-07-30 — Project automations checkpoint

- Added project-scoped scheduled and manual automations with persisted schedules and run history.
- Added scheduler execution, overlap policy, model/runtime selection, WebSocket RPCs, authorization scopes, and an MCP automation toolkit.
- Added the Automations settings route and client state for creating, editing, running, pausing, and deleting automations.
- Verified the database migration and authenticated Automations route in an isolated live environment; formatting, lint, and affected client/shared type checks pass.
- Focused tests are present, but the current Vite+ runner fails before collecting any suite (`runner.config` is undefined). Server type checking also retains unrelated pre-existing errors in local desktop attach and replay-event tests.
- Remaining work: render image content returned by model tools directly in the chat timeline. Browser-profile and Tailnet proxy changes remain separate from this checkpoint.
