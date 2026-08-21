# Research: Codex shared supervisor × realtime voice coexistence

Resolves [#131](https://github.com/shuv1337/shuv2code/issues/131) (wayfinder map [#129](https://github.com/shuv1337/shuv2code/issues/129)).

**Question.** Can realtime voice (`thread/realtime/*` JSON-RPC surface) run through the shared
supervised Codex app-server (`codex app-server --listen unix://`, `CodexAppServerSupervisor`), or
does realtime require per-session stdio children?

**Verdict: realtime voice works in shared mode — by explicit design.** The shared supervisor is
realtime-aware end to end, and upstream `codex app-server` routes `thread/realtime/*` notifications
per connection in a way that makes shared-topology routing behaviorally identical to per-session
stdio. There are real constraints (below), the sharpest being that realtime enablement in shared
mode is a **process-level, restart-only** decision, while per-session mode decides it per spawn.

All facts below carry file references. shuv2code references are to `main` at the time of research
(2026-08-21); upstream `openai/codex` references are to commit `536f86e5cc9e` (2026-08-21).

---

## 1. How the shared topology carries realtime

### 1.1 Supervisor resolves realtime enablement once per process

`apps/server/src/provider/Layers/CodexAppServerSupervisor.ts`:

- Topology comes from the restart-only setting `codexAppServerTopology`
  (`packages/contracts/src/settings.ts:668`, doc comment: "Cutover is restart-only; never mix
  owners for one home").
- At supervisor construction, realtime enablement is resolved **once** from the voice policy
  (lines 111–114):

  ```ts
  const sharedRealtimeEnabled =
    topologySetting === "shared" ? yield* resolveSharedRealtimeEnablement() : false;
  ```

  `resolveSharedRealtimeEnablement` (lines 371–380) maps `resolveVoiceControlPolicy(settings).realtime`
  (i.e. `enableRealtimeVoice` minus the `SHUV2CODE_REALTIME_VOICE_FORCE_DISABLED` env deny,
  `apps/server/src/serverSettings.ts:79–99`).
- The shared child is spawned with that flag baked into its argv (lines 225–228):

  ```ts
  const args = codexSessionAppServerArgs(undefined, keyInput.launchArgs, {
    listenUnixPath: socketPath,
    enableRealtimeConversation: sharedRealtimeEnabled,
  });
  ```

  `codexSessionAppServerArgs` (`apps/server/src/provider/Layers/codexLaunchArgs.ts:62–82`) appends
  `--listen unix://<socketPath>` (stripping any user-supplied `--listen`) and, when enabled,
  `--enable realtime_conversation`.
- The flag is part of process identity: `codexAppServerSupervisorKey`
  (`codexLaunchArgs.ts:84–96`) joins `binaryPath / codexHome / launchArgs / ("realtime"|"text")`,
  so a realtime-enabled and a realtime-disabled process can never share a socket. The interface
  doc is explicit (`apps/server/src/provider/Services/CodexAppServerSupervisor.ts:41–46`):
  "Realtime conversation enablement decided once per supervised process from the resolved voice
  policy at supervisor construction. Per-session flags never influence shared launch identity."
- Test coverage: `CodexAppServerSupervisor.test.ts:230–236` asserts the spawned shared argv
  contains `realtime_conversation` iff `supervisor.sharedRealtimeEnabled`.

### 1.2 Per-session runtime in shared mode: one WS connection per session

`apps/server/src/provider/Layers/CodexSessionRuntime.ts:1345–1394`:

- With `options.sharedAppServer` set, the runtime **does not spawn**; it acquires one connection
  from the supervisor (`connection.client` + `connection.terminated`).
- Without it (per-session topology), it spawns its own stdio child, adding
  `--enable realtime_conversation` only when
  `threadPurpose === "voice-transport" && enableRealtimeConversation === true` (lines 1357–1361).

Each acquired connection is a **separate WebSocket-over-unix-socket client** to the same process:
`CodexAppServerSupervisor.ts:73–88` (`connectUnixSocket`) builds `CodexClient.layerUnixSocket`,
which wraps `makeUnixWebSocketStdio`
(`packages/effect-codex-app-server/src/_internal/unixWebSocket.ts`) — a hand-rolled WS client
(HTTP Upgrade handshake, one JSON-RPC message per text frame, adapted to the NDJSON protocol
layer). `packages/effect-codex-app-server/src/client.ts:276–286` (`layerUnixSocket`) is identical
to the stdio client (`layerChildProcess`, lines 266–270) above the transport seam — same request /
notify / `handleServerNotification` surface, so **the entire realtime client code path is
transport-agnostic**.

### 1.3 Adapter wiring

`apps/server/src/provider/Layers/CodexAdapter.ts:1814–1826`: shared topology is active only when
the supervisor service is present **and** reports `topology === "shared"`; otherwise per-session
spawning. Lines 1926–1942 pass `sharedAppServer.acquireConnection` (keyed by binary/home/launch
args/cwd/runtimeDir) into the runtime. `input.enableRealtimeConversation` still flows into
`runtimeInput` (lines 1918–1920) — in shared mode it no longer affects argv, but it still gates
the client-side realtime lane (see §3.1).

---

## 2. Notification routing: identical in shared and per-session topology

### 2.1 shuv2code side

The realtime start flow is:

1. `VoiceRuntimeGateway.startTransport`
   (`apps/server/src/voice/Layers/VoiceRuntimeGateway.ts:613–736`) calls
   `provider.startSession(... threadPurpose: "voice-transport", enableRealtimeConversation: true)`,
   then `provider.startRealtime(...)` with the browser's SDP offer, then waits (20 s,
   `NEGOTIATION_TIMEOUT`) on the provider event stream for a `thread.realtime.sdp` event fenced by
   exact `runtimeInstanceId` + `generation` + `realtimeSessionId` (lines 679–692).
2. `CodexAdapter.startRealtime` (`CodexAdapter.ts:2216–2259`) forwards to
   `runtime.startRealtime` with `version: "v3"`, `outputModality: "audio"`.
3. `CodexSessionRuntime.startRealtime` (`CodexSessionRuntime.ts:2547–2588`) issues
   `client.request("thread/realtime/start", …)` under a per-runtime realtime lane (semaphore +
   state machine).
4. Incoming `thread/realtime/*` notifications are annotated with a fence
   (`_shuv2codeRealtime`: runtimeInstanceId / generation / realtimeSessionId / ingressSequence)
   by `annotateRealtimeNotification` (`CodexSessionRuntime.ts:1473–1528`) and mapped to
   `thread.realtime.*` provider events by `CodexAdapter.ts:1488–1646`. The SDP answer surfaces as
   `thread.realtime.sdp` (`CodexAdapter.ts:1591–1607`).

Every step operates on `client` — the runtime's own connection. Nothing in this path branches on
topology, so routing is **identical by construction on the client side**.

### 2.2 Upstream side (openai/codex @ 536f86e5cc9e)

The question is whether one shared process delivers thread notifications to the right connection:

- The unix-socket transport accepts **multiple concurrent WS connections**
  (`codex-rs/app-server-transport/src/transport/unix_socket.rs:46–91`: accept loop spawns
  `run_websocket_connection` per stream; socket file mode `0o600`, line 22).
- Outgoing messages are routed per envelope: `ToConnection` vs `Broadcast`
  (`codex-rs/app-server/src/outgoing_message.rs:92–100`,
  `codex-rs/app-server/src/transport.rs:200–239`).
- Thread events — including all realtime events — are sent through a
  `ThreadScopedOutgoingMessageSender` constructed from
  `thread_state_manager.subscribed_connection_ids(conversation_id)`
  (`codex-rs/app-server/src/request_processors/thread_lifecycle.rs:340–347`), i.e. **only to
  connections subscribed to that thread**. A connection subscribes by starting/resuming/attaching
  to the thread (`codex-rs/app-server/src/thread_state.rs:540–552`; every
  `thread/realtime/*` request re-attaches the calling connection via
  `ensure_conversation_listener`,
  `codex-rs/app-server/src/request_processors/turn_processor.rs:1049–1078`).
- All eight realtime notifications (`started`, `sdp`, `itemAdded`, `transcript/delta`,
  `transcript/done`, `outputAudio/delta`, `error`, `closed`) go through that thread-scoped sender
  (`codex-rs/app-server/src/bespoke_event_handling.rs:418–522`).

Net: in shared mode each shuv2code session runtime's connection receives realtime notifications
**only for its own thread(s)** — the same observable behavior as a dedicated stdio child.

One dependency worth recording: shuv2code's realtime lane state machine
(`transitionRealtimeLaneForNotification`, `CodexSessionRuntime.ts:398–431`) fences
`thread/realtime/started` by `realtimeSessionId`, but accepts subsequent realtime notifications
whenever the lane is `active`/`stopping` **without checking the notification's `threadId`**
(`annotateRealtimeNotification` runs before the foreign-conversation suppression at
`CodexSessionRuntime.ts:1803–1889`). Shared-mode correctness therefore relies on upstream's
thread-scoped delivery just described. That guarantee holds today; a future upstream change to
broadcast realtime notifications would need a `threadId` check added to the lane.

### 2.3 SDP / media transport constraints

None specific to the unix socket. The WebRTC SDP exchange is pure signaling over JSON-RPC: the
offer travels in `thread/realtime/start` params, and upstream forwards it to the realtime backend,
emitting the remote answer as a `thread/realtime/sdp` notification
(`codex-rs/core/src/realtime_conversation.rs:1505–1556`; `codex-rs/app-server/README.md:215`:
"pass `{ "type": "webrtc", "sdp": "..." }` … the remote answer SDP is emitted as
`thread/realtime/sdp`"). Media then flows between the end client and the backend — not through the
control channel — so process topology is irrelevant to the media path. For the
`websocket` (PCM) transport, audio chunks do traverse the control channel as base64
`thread/realtime/appendAudio` requests (`CodexAdapter.ts:2294–2312`, 24 kHz mono), which in shared
mode multiplexes that load onto the one supervised process (each session still has its own socket
connection).

---

## 3. Version / feature gates

### 3.1 shuv2code gates (topology-independent)

- `MINIMUM_REALTIME_CODEX_VERSION = "0.146.0"`
  (`apps/server/src/voice/Layers/VoiceRuntimeGateway.ts:40`), enforced in
  `resolveModelSelection` against the provider registry snapshot version (lines 410–419) with
  error `incompatible_version`. Applied before any transport start; identical in both topologies.
- The realtime lane refuses non-voice runtimes regardless of topology:
  `requireRealtimePurpose` (`CodexSessionRuntime.ts:2373–2381`) requires
  `threadPurpose === "voice-transport" && enableRealtimeConversation === true`, else
  `unsupported_runtime_purpose`.
- `listRealtimeVoices` (`CodexAdapter.ts:2327–2387`) probes `experimentalFeature/list` and reports
  `feature_disabled` when `realtime_conversation` exists but is not enabled, and
  `method_unavailable`/`incompatible_version` for older binaries.

### 3.2 Upstream feature gate

`realtime_conversation` is an under-development feature, default **off**
(`codex-rs/features/src/lib.rs:1466–1471`). `--enable realtime_conversation` folds into config
overrides at CLI parse (`codex-rs/cli/src/main.rs:1059–1061`) — i.e. **process-wide**. Every
`thread/realtime/*` request checks `thread.enabled(Feature::RealtimeConversation)` and rejects
with "thread {id} does not support realtime conversation" otherwise
(`codex-rs/app-server/src/request_processors/turn_processor.rs:1049–1078`).

### 3.3 The shared-mode consequences

1. **Restart-only enablement.** In shared mode the `--enable realtime_conversation` decision is
   captured once at supervisor construction from voice policy. If voice was disabled at server
   start and is enabled later, the already-running shared process (and any future process — the
   captured `sharedRealtimeEnabled` const never re-resolves) lacks the feature, and
   `thread/realtime/start` fails upstream until the shuv2code server restarts. Per-session
   topology re-evaluates per spawn (`CodexSessionRuntime.ts:1357–1361`), so toggling voice takes
   effect on the next transport session.
2. **Feature bleed to work threads.** When enabled, *every* thread in the shared process has
   `Feature::RealtimeConversation` on — including specialized work sessions. Exposure is bounded:
   shuv2code's own gate (§3.1) refuses realtime calls for non-voice-transport runtimes, and the
   control socket is private to the server (mode `0600`,
   `unix_socket.rs:22`; socket dir under the server's `stateDir`,
   `CodexAppServerSupervisor.ts:216–218`).

---

## 4. Supervisor limitations relevant to voice + work coexistence

- **Shared blast radius.** One supervised process per (binary, home, launchArgs, realtime) key
  serves the voice controller thread, the voice transport thread, and all specialized work
  sessions for that Codex home. A crash tears down every connection at once: `handleProcessExit`
  (`CodexAppServerSupervisor.ts:162–189`) closes the child scope; each runtime observes its
  `connection.terminated` (`CodexAppServerSupervisor.ts:29–37`, wired via `onTermination` in
  `connectUnixSocket`). An active realtime call dies with it. Restart backoff is shared and
  bounded (500 ms base, 5 s cap, `restartBackoffMs`, lines 63–67).
- **Process reuse at refCount 0.** `releaseConnection` (lines 292–302) keeps the process
  registered so it stays the single owner of its Codex home until supervisor teardown — a voice
  session ending never kills work sessions' process, and vice versa.
- **Per-digest serialization.** Acquisitions of the same key serialize through a semaphore lane
  (lines 117–129) to avoid double-spawn; distinct keys (e.g. different Codex homes) proceed
  concurrently.
- **Realtime concurrency.** The realtime lane (semaphore + generation state machine) is
  **per session runtime**, not per process (`CodexSessionRuntime.ts:1332–1334`), and upstream
  realtime state is per thread (`prepare_realtime_conversation_thread` loads the thread;
  `Op::RealtimeConversationStart` is a thread op). Nothing in either codebase makes realtime a
  process-level singleton, so one voice transport plus N work sessions — or even multiple voice
  transports — can coexist on one shared process.
- **MCP config differences (adjacent, not blocking).** Shared topology carries per-session MCP
  endpoints as per-thread `config` overrides on `thread/start|resume`
  (`CodexAdapter.ts:1875–1899`) instead of launch args + env vars; the voice controller's MCP
  credential still reaches its thread that way. Realtime is unaffected.

---

## 5. Answer matrix

| Aspect | Shared supervisor | Per-session stdio |
| --- | --- | --- |
| `thread/realtime/*` RPCs | ✅ same client surface over unix-WS (`client.ts:276–286`) | ✅ |
| SDP answer via `thread/realtime/sdp` | ✅ thread-scoped delivery to owning connection | ✅ single connection |
| Notification routing identical? | ✅ behaviorally identical (upstream `subscribed_connection_ids`) | baseline |
| `MINIMUM_REALTIME_CODEX_VERSION` (0.146.0) | applies (topology-independent) | applies |
| `--enable realtime_conversation` | process-wide, resolved once from voice policy, **restart-only** | per spawn, voice-transport only, dynamic |
| Voice + work sessions on one process | ✅ supported; shared crash blast radius | n/a (isolated) |
| WebRTC media path | client ↔ backend, unaffected by topology | same |
| websocket/PCM audio path | JSON-RPC frames over shared process's socket (per-connection) | per-child stdio |

**Bottom line for #138 planning:** realtime voice does **not** force per-session children. The
shared topology was built with realtime as a first-class input to process identity. The two things
to design around are (a) restart-only realtime enablement in shared mode, and (b) the shared crash
blast radius across voice and specialized work sessions.
