# Research: shuvcode extension-gap audit

Resolves [#130](https://github.com/shuv1337/shuv2code/issues/130) (wayfinder map [#129](https://github.com/shuv1337/shuv2code/issues/129)).
Facts only; no recommendations beyond flagging gaps.

## Sources examined

- **Latitudes-Dev/shuvcode** at commit `9f7c0b2fee78b9bffefbc5a98d0f8581dd4bad12` (2026-08-19, PDT), shallow clone. This repo is the source of the `shuvcode` npm package (`packages/cli` has `"name": "shuvcode"`; `npm view shuvcode repository.url` → `github.com/Latitudes-Dev/shuvcode`). Published `latest` at audit time: **2.0.0-alpha-15**.
- **shuv2code** working copy (read-only): `apps/server/src/provider/Drivers/OpenCodeV2Driver.ts`, `apps/server/src/provider/opencodeV2Service.ts`, `apps/server/src/provider/opencodeV2Client.ts`, `apps/server/src/provider/Layers/OpenCodeV2Adapter.ts`, `apps/server/src/provider/Layers/OpenCodeV2Binding.ts`, `apps/server/src/provider/Layers/OpenCodeAdapter.ts` (v1 comparison), `apps/server/src/provider/opencodeRuntime.ts`.
- `.repos/` in shuv2code contains only `alchemy-effect` and `effect-smol` — **no vendored shuvcode tree**.
- ADE requirements context: [psychoharness/ADE-FORK-DECISION.md](https://github.com/shuv1337/psychoharness/blob/main/ADE-FORK-DECISION.md) (§2.3 "shuvcode is ours to extend").

Shuvcode paths below are relative to the shuvcode repo; shuv2code paths relative to the shuv2code repo.

## Attach-path baseline (shared context for all bullets)

- shuv2code's v2 driver **attaches, never spawns**: `requireOpenCodeV2Service` (`apps/server/src/provider/opencodeV2Service.ts:324-341`) discovers the user's `opencode service start` background service via the registration file in `$XDG_STATE_HOME/opencode/` (`service.json` / `service-<channel>.json`) and errors if unhealthy. `opencodeRuntime.ts:801-829` comments: "Attach only — never spawn a private V2 serve."
- The v2 HTTP surface is defined in shuvcode `packages/protocol/src/api.ts` + `packages/protocol/src/groups/*` and served by `packages/server/src/routes.ts`. Auth is a **single shared basic-auth password with fixed username `opencode`** (`packages/server/src/auth.ts`); there is no per-client identity, so the service cannot distinguish shuv2code from any other API client.

---

## 1. Session ownership / metadata (tagging a session as ADE/bot-owned)

**Verdict: missing at session level; partial at message level.**

- `Session.Info` (shuvcode `packages/schema/src/session.ts:31-53`) has `id, parentID, fork, projectID, agent, model, cost, tokens, time, title, location, subpath, revert, policy` — **no owner, tag, label, or metadata field**.
- `session.create` payload (`packages/protocol/src/groups/session.ts:150-158`) accepts only `id?, title?, agent?, model?, location?, policy?`. No place to stamp an owner.
- The `session_v2` SQLite table *does* have a `metadata: text({mode:"json"})` column (`packages/core/src/database/schema.gen.ts`, `packages/core/src/session/sql.ts:43`), but it is written only by the v1→v2 migration (`packages/core/src/database/v1-migration.bun.ts`) and is not exposed through `Session.Info` or any endpoint.
- **Partial (per-message):** `session.prompt` and `session.synthetic` accept `metadata: Record<string, unknown>` (`SessionInbox.UserPayload` / `SyntheticPayload`, `packages/schema/src/session-inbox.ts:15-25`), persisted onto projected messages (`Session.Message` base `metadata`, `packages/schema/src/session-message.ts:34`). An orchestrator can tag every message it sends, but not the session row itself.
- **Partial (constraint, not ownership):** per-session `Session.Policy` — a deny-by-default exact-ID tool allowlist (`packages/schema/src/session-policy.ts`), settable at create and fork.
- **Partial (durable per-session KV, but model-facing):** instruction entries — `PUT/GET/DELETE /api/session/:sessionID/instructions/entries/:key` store arbitrary JSON per key (`groups/session.ts:566-611`), but changes are "announced as updates at the next step boundary", i.e. they feed the model, not silent bookkeeping.
- shuv2code tracks thread↔session ownership entirely on its own side (resume cursor `{sessionId, activeTurnId}`, `OpenCodeV2Adapter.ts:60-66, 213-224`); nothing marks the shuvcode session as shuv2code/bot-owned.

## 2. Dynamic per-session MCP add on the attach path

**Verdict: runtime MCP add exists server-side but is location-scoped, not session-scoped; the shuv2code v2 attach path performs no MCP injection at all.**

- Server-side runtime MCP management exists (`packages/protocol/src/groups/mcp.ts`):
  - `PUT /api/mcp/:server` — "Add an MCP server at runtime or replace an existing one, connecting it immediately."
  - `DELETE /api/mcp/:server` — remove "from the runtime set **until restart**".
  - `POST /api/mcp/:server/connect` / `.../disconnect`, `GET /api/mcp`, `GET /api/mcp/resource`.
  - Config union `Mcp.ServerConfig` = local (`command, cwd, environment, timeout`) or remote (`url, headers, oauth, timeout`) (`packages/schema/src/mcp.ts:19-54`) — static per-server headers are possible.
- Scoping: every MCP endpoint takes a `LocationQuery` (`{location: {directory?, workspace?}}`, `groups/location.ts:5-13`). The MCP service is a **location node** (`MCP.node`, `packages/core/src/mcp/index.ts`), and its tools are registered into the location-shared tool registry (`packages/core/src/tool/mcp.ts` reconcile loop). A runtime-added server's tools become visible to **every session at that location**; there is no session-scoped MCP registration.
- Runtime adds are in-memory (`MCP.add` → `replaceServer`, `packages/core/src/mcp/index.ts:683-688`); the API text confirms they do not survive restart.
- shuv2code v1 comparison: `OpenCodeAdapter.ts:1464-1485` injects per-thread MCP sessions via `client.mcp.add(...)` **only when `!server.external`** — i.e. v1 skipped MCP injection for external servers, as the ticket states.
- shuv2code v2: `opencodeRuntime.ts:818-823` marks the attached background service `external: false` with the comment "while still allowing shuv2code MCP registration", **but no registration is implemented**: `OpenCodeV2Adapter.ts` contains zero MCP references, and `opencodeV2Client.ts` does not even wrap `/api/mcp` (its full surface is `event.subscribe`, `session.{create,get,messages,fork,prompt,interrupt,wait,active,rename}`, `form.*`, `permission.*`, `provider/model/agent/skill.list`).

## 3. Synthetic input admission (assignment results / notifications as input)

**Verdict: present server-side; unused by shuv2code.**

- `POST /api/session/:sessionID/synthetic` (`groups/session.ts:387-407`): payload `{id?, text, description?, metadata?, delivery?, resume?}` — "Durably admit synthetic session input and schedule execution unless resume is false."
- Durable admission into the inbox as `SessionInbox.Synthetic`; default delivery `"steer"` (`packages/core/src/session.ts:915-930`); projected as `Session.Message.Synthetic` (`packages/schema/src/session-message.ts:84-90`).
- Related admission channels also exist: `session.shell` (runs a command and records shell.started/ended messages), `session.skill`, `session.command`, and system messages (`Session.Message.System`).
- shuv2code's `opencodeV2Client.ts` has no `synthetic` wrapper and the v2 adapter never calls it.

## 4. Queue-vs-steer inbox semantics and interrupt APIs

**Verdict: present and complete server-side; shuv2code uses only the bare subset.**

- `SessionInbox.Delivery = "steer" | "queue"` (`packages/schema/src/session-inbox.ts:11`). Accepted by prompt, command, synthetic, compact, and move. Defaults: prompt/synthetic/move → `"steer"`, compaction → `"queue"` (`packages/core/src/session.ts:645, 835, 875, 925`).
- Semantics (`packages/core/src/session/inbox.ts:43-48`, `promote` at `:526`): the `Promotable` scope `"steer"` promotes steers at a **step boundary mid-work**, while `"input"` also allows one queued item at the **idle boundary**.
- Inbox endpoints (`groups/session.ts:513-564`): `GET /api/session/:id/inbox` (durable, ordered, undelivered work), `DELETE /inbox/:inboxID` (cancel undelivered), `POST /inbox/:inboxID/steer` (re-flag to steer and wake execution), `POST /inbox/:inboxID/queue`.
- Interrupt: `POST /api/session/:sessionID/interrupt?continue=true|false` (`groups/session.ts:652-667`) — "When continue=true, execution resumes pending steering input while queued work remains parked." Plus `POST /:id/wait` (block until idle) and `POST /:id/background` (move blocking foreground tools to background observation).
- Durable inbox lifecycle events: `session.inbox.enqueued/delivered/cancelled/delivery.changed` (`packages/schema/src/session-event.ts:164-193`).
- shuv2code v2 client wraps only `prompt` (no `delivery`, no `metadata`), `interrupt` (no `continue`), and `wait`; no inbox endpoints.

## 5. Session listing / creation APIs for an external orchestrator

**Verdict: present.**

- `GET /api/session` (`groups/session.ts:130-147`): filters `directory | project(+subpath) | workspace`, `parentID` (incl. `null` for roots only), `search`, `limit`, `order`, plus opaque base64url cursor pagination (`SessionsCursor`).
- `POST /api/session`: create with optional **client-supplied id**, `title`, `agent`, `model`, `location`, `policy`.
- `GET /api/session/active`: "foreground Session drains currently owned by this OpenCode process" — a live busy-map.
- Also: `get`, `delete`, `fork` (boundary through/before a message, with policy), `rename`, `move`, `switchAgent`, `switchModel`, `export`/`import` (full projected transcripts), `context`, `generate`, `message` fetch, `environment` set.
- Event surfaces for orchestration: global SSE `GET /api/event` (volatile by contract — "a slow consumer overflows and fails the stream, and events during disconnection are missed"; stream starts with `server.connected`) and the **experimental durable per-session log** `GET /api/experimental/session/:sessionID/log?after=<seq>&follow=true` (`groups/session.ts:632-649`) that replays durable events after an exclusive aggregate sequence and then follows live.
- shuv2code v2 client wraps `create/get/active` but not `list`.

## 6. Restart / recovery behavior of the background service and its sessions

**Verdict: present for service supervision and durable state; deliberately absent for automatic turn resumption.**

- **Discovery/registration:** the service writes `$XDG_STATE_HOME/opencode/service.json` (channel-suffixed variants) containing `{url, pid, password?, version?}`; health probes `GET /api/health` → `{healthy: true, version, pid}` with pid cross-check (shuv2code mirrors this in `opencodeV2Service.ts`; shuvcode health schema in `packages/protocol/src/groups/health.ts`). Graceful stop: `POST /api/service/stop` with exact `instanceID`.
- **Supervision:** the shuvcode CLI service lifecycle (`packages/cli/src/services/service-lifecycle.ts`) supports a **systemd user unit `shuvcode.service`** on Linux — ensure/stop/restart/status with verification that the registered process belongs to the unit's MainPID tree — falling back to portable `Service.ensure` management otherwise.
- **Durable session state:** sessions, messages, inbox, and durable events live in SQLite (`packages/core/src/session/sql.ts`, drizzle). Inbox items survive restart; runtime MCP adds do not.
- **Crash semantics** (`packages/core/src/session/execution.ts:64-77`): a **write-ahead execution claim** (`time_suspended` column + `resume_attempts`) is recorded transactionally with `session.execution.started`; terminal events release it; *shutdown* interruption preserves it. "The claim is an inert recovery marker only. Nothing resumes it: start-up performs no sweep and never replays provider work for an orphaned claim. Continuing an interrupted turn is a user-initiated prompt, and automatic post-crash continuation is a separate explicit design." `session.execution.interrupted` carries `reason: "user" | "shutdown" | "superseded"`.
- **shuv2code side:** durable resume cursor `{sessionId, activeTurnId}`; `hasDurableSessionRecovery` is cursor-presence (`OpenCodeV2Adapter.ts:1158-1160`); on start it re-adopts via `session.get`, recovers projected tool names, and hydrates pending permissions/forms; if the session is gone it creates a fresh one.

## 7. Invocation proof / turn metadata for trusted-turn correlation of MCP tool calls

**Verdict: rich internal correlation; nothing crosses the MCP boundary — no invocation proof.**

- **Internal (present):** durable events give full in-server correlation:
  - `session.step.started` `{sessionID, assistantMessageID, agent, model, snapshot?}` (`packages/schema/src/session-event.ts:285-300`);
  - `session.tool.input.started/ended`, `session.tool.called`, `session.tool.success/failed` all carry `{sessionID, assistantMessageID, id}` where `id` is the tool-call id (`session-event.ts:430-540`);
  - the tool execution context carries `sessionID, messageID, id, agent`, used for the permission assertion `source: {type: "tool", messageID, id}` (`packages/core/src/tool/mcp.ts` execute closure).
- **Across the MCP boundary (missing):** `MCP.callTool` forwards only `{name, args}` (`packages/core/src/mcp/index.ts:719-729`), and the SDK client sends `{name, arguments}` with no `_meta` and no per-call headers (`packages/core/src/mcp/client.ts:387-395`). An MCP server receiving a call **cannot determine — let alone prove — which session or turn invoked it**. There is no signed token, nonce, or turn attestation anywhere in the tree (no matches for attestation/invocation-proof concepts outside unrelated files).
- MCP elicitations are explicitly location-scoped, not session-scoped: `GLOBAL_ELICITATION_SESSION_ID = "global"` with the comment "the server cannot attribute them to a persisted session row" (`packages/core/src/mcp/index.ts:127-130`). shuv2code's server carries a matching warning about the `sessionID === "global"` sentinel (`packages/server/src/api.ts` in shuvcode).
- shuvcode has **no first-class "turn" resource**; `assistantMessageID` per step is the closest stable handle. shuv2code's `TurnId`s (`opencode2-turn-<uuid>`, `OpenCodeV2Adapter.ts:524, 1090`) are synthesized locally in the adapter and never known to shuvcode.
- Because auth is one shared password (see baseline), even HTTP-level attribution of *which client* triggered work is impossible.

---

## Summary table

| ADE primitive | Status in shuvcode (2.0.0-alpha-15 / 9f7c0b2) | Status in shuv2code v2 attach path |
| --- | --- | --- |
| Session ownership metadata | **Missing** (no owner/metadata on `Session.Info` or create; unexposed DB column); partial via per-message `metadata` and per-session `policy`/instruction entries | Tracked only shuv2code-side (resume cursor) |
| Dynamic per-session MCP add | **Partial**: runtime `PUT /api/mcp/:server` exists but is location-scoped, non-persistent; no session scoping | **Missing**: v2 adapter/client never touch MCP (v1 only, and only for non-external servers) |
| Synthetic input admission | **Present**: `POST /:id/synthetic` durable, steer/queue, resume flag | Not wrapped/used |
| Queue-vs-steer + interrupt | **Present**: delivery on all admissions, inbox list/cancel/steer/queue, `interrupt?continue=`, wait, background | Bare `prompt`/`interrupt`/`wait` only |
| Session list/create for orchestrator | **Present**: filtered+paginated list, create with client id/policy, active map, fork, export/import, durable per-session event log | Client wraps create/get/active; no list |
| Restart/recovery | **Present** (supervised service, durable inbox/events, write-ahead claim); **no automatic turn resumption by design** | Durable resume cursor; re-adopt via `session.get` |
| Invocation proof / trusted-turn correlation | **Missing across MCP boundary** (no `_meta`, no identity, no signature; elicitations use `"global"` sentinel); internal event correlation is rich (`sessionID`+`assistantMessageID`+tool-call `id`) | Turn ids synthesized locally; no shuvcode turn resource |
