# Screenbox upstream surface audit

Resolves wayfinder research ticket [#132](https://github.com/shuv1337/shuv2code/issues/132) (part of map #129).

- **Upstream audited:** [dklymentiev/screenbox](https://github.com/dklymentiev/screenbox) at commit `f7bebc38685cfd08b850ea64ef31c6de74d8e023` (2026-04-15, tip of `main` at audit time, 2026-08-21).
- **Compared against:** ADE-FORK-DECISION.md §3.4–3.5 ([psychoharness](https://github.com/shuv1337/psychoharness/blob/main/ADE-FORK-DECISION.md)), the 2026-08-20 locked Screenbox lifecycle checkpoint.
- **Scope:** facts and gaps only. No design.

## 1. Container / compose layout and images

Compose stack (`docker-compose.yml`) has three services plus a build-only profile:

| Service | Image | Role | Limits |
|---|---|---|---|
| `screenbox-mcp` | built from `docker/mcp/Dockerfile` | Python MCP server + HTTP API on :8080 (bound `127.0.0.1:8080`), sole controller of desktops | 2g / 1.0 cpu |
| `screenbox-dashboard` | built from `dashboard/Dockerfile` | Pure-UI web dashboard on :16000 (bound `127.0.0.1:16000`); proxies everything through the MCP HTTP API | 256m / 0.5 cpu |
| `screenbox-socket-proxy` | built from `docker/proxy/Dockerfile` | Docker API allowlist proxy; mounts `/var/run/docker.sock:ro`, exposes `tcp://…:2375` to the MCP container (`DOCKER_HOST`) | 128m / 0.25 cpu |
| `screenbox-desktop-build` | `docker/Dockerfile` → `screenbox:latest` | build profile only; desktops are launched dynamically by the manager, not by compose | — |

Desktop images:

| Image | Contents |
|---|---|
| `screenbox:latest` (~920 MB, `docker/Dockerfile`) | Debian bookworm-slim + XFCE, Xvnc (TigerVNC, `:5900`), xrdp (`:3389`, auto-connects to local VNC via `libvnc.so`), Chromium (wrapped with `--no-sandbox --test-type`), AT-SPI stack, xdotool/wmctrl/xclip, ws-bridge (`ws-bridge.py`, `:8765`) for the bundled Chromium CDP extension, gnome-keyring, non-root user `screenbox` (uid 1000). Healthcheck: `pgrep xrdp && pgrep Xvnc`. |
| `screenbox:mate` (~1.7 GB, `docker/Dockerfile.mate`) | Full MATE variant of the same. |

Desktop containers are created by `DesktopManager.create()` (`src/screenbox/manager.py`) via `docker create` + `docker start` (through the socket proxy), named `screenbox-<desktop_id>`, labeled `screenbox.desktop=true`, with `--restart unless-stopped`, dual-network (bridge + the compose `screenbox` network for the dashboard's VNC/RDP proxy). All operations flow MCP server → manager → Docker API; the docker-proxy allowlist covers container create/start/stop/kill/delete/exec/archive, network connect/disconnect, and read-only info endpoints — notably **no `volumes` endpoints** (volume ops run as `docker volume …` CLI calls from the MCP container against the proxy, which does not allowlist them; volume rm is a CLI call in `delete_data()`).

## 2. Per-desktop resource knobs

Set at `docker create` time per container (`manager.py::create`):

- `-m <memory_per_desktop>` and `--memory-swap` equal to it (no swap) — value is **global config** (`~/.screenbox/config.json`, default `2048m`), not per-desktop-parameterized in the create API.
- `--cpus 2` — **hardcoded**, not configurable per desktop or globally.
- `--shm-size=256m` — hardcoded (README claims 512m; code says 256m).
- Per-desktop at create: `resolution` (`WIDTHxHEIGHT`, else config `default_viewport`, default 1920x1080), `image` (else config `image`), `label`, startup `url`, JSON "profile" (fake-identity template from `profiles/`).
- Global caps: `max_desktops` (default 5; 3 on macOS/WSL2), `port_bind_address` (default `127.0.0.1`), `chrome_args`.
- Memory observability: `desktop_manage(action="health")` reads cgroup usage and emits a warning at >80%.

## 3. Create / start / stop / destroy APIs and idle hooks

Three parallel surfaces backed by one manager:

1. **MCP tool** `desktop_manage` with `action` ∈ `create, destroy, list, status, pause, resume, acquire, release, smart_acquire, heartbeat, health, snapshot_save, snapshot_restore, snapshot_list, …` (plus clipboard, overlay, app/process, input helper actions).
2. **HTTP API** on the MCP server (`src/screenbox/http_api.py`): `POST /api/desktop/create`, `/destroy`, `/delete-data`, `/control` (`pause|resume|stop|start`), `GET /api/desktop/list|status|stats|screenshot|ip`, `POST /api/desktop/input|overlay|record`, `GET /api/events` (SSE), `GET /api/health`, plus `/api/agent/*`, `/api/desktop/assign|unassign|assignments|my|share*`, `/api/knowledge/*`, `/api/logs/*`.
3. **Dashboard** endpoints that proxy to (2).

Lifecycle semantics (facts):

- `create(desktop_id, …)`: validates id (`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$`), **returns the existing desktop if already RUNNING** (create is re-entrant on a running container; a stopped container is removed and recreated). Enforces `max_desktops`. Auto-restores the latest snapshot if one exists for that id. Ports allocated from base 16080 upward per desktop (rdp/vnc/ws triplet).
- `stop` / `start`: plain `docker stop` / `docker start`; named home volume persists.
- `pause` / `resume`: `docker pause` (cgroup freeze — **container stays resident in RAM**) / `docker unpause`. Pause auto-snapshots first.
- `destroy`: removes the container but **keeps data** — state becomes `SAVED`; the home volume and the dossier stay. Explicit `delete_data()` (`POST /api/desktop/delete-data`) removes the dossier dir and `docker volume rm -f screenbox-<id>-home`. MCP `destroy` requires `confirm=True` and defaults to saving a snapshot first; in strict-auth mode destroy requires authentication.
- Recovery: on startup the manager re-adopts all `screenbox-*` containers and discovers "saved" desktops (dossier + home volume present, no container). A 30s sync loop reconciles in-memory state with `docker ps`.

Idle-detection hooks:

- `DesktopManager.touch()` updates `last_tool_call` on every `manager.exec()` (i.e., every MCP tool call that reaches the container).
- A background idle checker (60s interval) implements: (a) stale-lease **logging only** (leases are never auto-released; "admin release required"), (b) periodic auto-snapshot (`auto_snapshot_minutes`, default 30), (c) **auto-pause** after `idle_pause_minutes` (default 20, 0=off) — pause, not stop, and only for desktops **not** acquired by an agent.
- Viewer activity is **not** an idle input: the dashboard's VNC/RDP websocket proxy does not touch `last_tool_call`, so a human watching/controlling via VNC does not by itself keep a desktop "active".

Agent leasing (in-memory, `manager.py`): `acquire(desktop_id, agent_id)` → exclusive lock + 16-hex `session_token`, `lease_ttl` default 600s; `heartbeat`, `release`, and `smart_acquire` (reuse own → any idle running → error with guidance). Locks live only in process memory (lost on MCP restart); persistent desktop→agent **ownership assignments** live in SQLite (`registry.py`).

## 4. MCP surface and credential model

- **Transports:** stdio (pip install, single agent), Streamable HTTP at `/mcp` (compose default, stateless, survives restarts), deprecated SSE at `/sse`. Any MCP client attaches by pointing at `http://host:8080/mcp` (docs/mcp-compatibility.md).
- **21 MCP tools:** 8 core (`desktop_screenshot/look/click/type/key/shell/batch/help`), 4 dispatchers (`desktop_chrome` ~30 browser actions via CDP extension, `desktop_window`, `desktop_file`, `desktop_manage`), 4 knowledge tools, 2 system (`screenbox_info`, `screenbox_logs`), 1 debug (`desktop_debug` incl. AT-SPI).
- **Auth model** (`auth_middleware.py`, `access.py`, `registry.py`):
  - Strict mode default on (`SCREENBOX_REQUIRE_AUTH`, disableable).
  - Admin: `SCREENBOX_API_TOKEN` (Bearer) or `SCREENBOX_ADMIN_KEY` — full access to all desktops.
  - Agents: `desktop_manage(action="register", agent_id=…)` → returns an `api_key` (stored **hashed** in SQLite at `<base_dir>/registry.db`); then either `action="login"` once per MCP connection, or pass the key on every request via `X-API-Key` header > `Authorization: Bearer` > `?token=` query param (that priority order).
  - **Credentials are per-agent, not per-desktop.** Desktop access is derived from ownership: agent-created desktops are assigned to that agent (persisted in SQLite); admin-created desktops are shared. There is also an unused-by-default stateless capability-token module (`auth.py`, HMAC-SHA256 `{agent, desktops[], exp}` tokens signed by a master secret) that *can* scope a token to desktop IDs, but the wired-in path is registry keys + ownership.
  - The desktop container itself has **no credentials**: Xvnc runs `-SecurityTypes None`, xrdp fronts it, and ports bind to `127.0.0.1` on the host by default. Isolation of the VNC/RDP plane is network-level, not credential-level.

## 5. Viewer endpoints and embed options

- Per-desktop host ports (bound to `port_bind_address`): RDP `:3389`→`1608x`, VNC `:5900`→`1608x+1`, ws-bridge `:8765`→`1608x+2`. Any RDP/VNC client can connect directly.
- Dashboard (aiohttp, `dashboard/server.py`): vendored **noVNC** client at `/novnc/*`; websocket VNC proxy at `/vnc/{desktop_id}` (an `/rdp/{desktop_id}` route maps to the same WS proxy); main UI `/`; standalone viewer page `/view?id=…` (`view.html`, RFB over the WS proxy).
- **Share links:** `POST /api/desktop/share` mints a TTL'd token (default 3600s, SQLite-backed, revocable); public page `/s/{token}` (`share.html`) renders a **view-only** noVNC session through `/share-vnc/{token}` without other auth. The main dashboard viewer supports view vs control modes (`rfb.viewOnly` toggled) and human take-control (state `HUMAN_CONTROLLED`).
- Embedding: no dedicated iframe/embed API beyond these URL-addressable pages (`/view`, `/s/{token}`); `vnc_lite.html` from noVNC is also shipped.

## 6. Persistent volume layout

Two mounts per desktop container (no host bind mounts to the desktop):

1. **Named home volume** `screenbox-<desktop_id>-home` → `/home/screenbox` — the whole home dir: Chromium profile (`~/.config/chromium`, migrated from any old `~/.config/google-chrome`), gnome-keyring (`~/.local/share/keyrings`, empty-password auto-unlock for cookie encryption), `downloads/`, `workspace/`, `Desktop/`, user-installed apt packages replayed from `~/.screenbox/installed-packages.txt` at boot. Survives stop/destroy; deleted **only** by `delete_data()` / explicit `docker volume rm`.
2. **Shared data volume** (`screenbox_screenbox-data`) → `/data/screenbox` — same volume the MCP server mounts; carries the per-desktop dossier `desktops/<id>/` (`meta.json`, optional `profile.json`, `recordings/`, `knowledge/`).

Server-side state under `SCREENBOX_BASE_DIR` (`~/.screenbox` or `/data/screenbox` in compose): `config.json`, `registry.db` (agents/sessions/assignments/shares), `desktops/<id>/` dossiers, `snapshots/<id>/snapshot-*.tar.gz[.age]` (tar of `/home/screenbox`, gzip on the server, optional age encryption, retention last 5), `logs/`, `master-secret`, `age-key.txt`.

## 7. Multi-desktop support on one host

Yes — designed for it: `max_desktops` cap (default 5), per-desktop port triplets from 16080, per-desktop containers/volumes/dossiers/snapshots, multi-agent registry with ownership scoping, dashboard listing all desktops, `smart_acquire` for pool-style reuse, and container recovery on MCP restart. All desktops share one Docker daemon, one desktop image, and one MCP server process.

## 8. Gaps vs ADE-FORK-DECISION §3.4–3.5

ADE locked requirements vs what upstream provides today:

| # | ADE §3.4–3.5 requirement | Upstream Screenbox fact | Gap |
|---|---|---|---|
| 1 | **Idempotent botId-keyed provisioning** with a durable provisioning record; concurrent triggers dedupe; failed provision surfaces to operator | `create()` is re-entrant for a RUNNING desktop and desktop_ids are caller-chosen strings, so botId-as-desktop_id gives partial idempotency. But there is **no durable provisioning record** (in-memory `_desktops` dict + reconciliation from `docker ps`; dossier `meta.json` is written only after create proceeds), **no concurrency dedupe** (no lock around create; two concurrent creates race on `docker create` name collision), and a create against a STOPPED container silently removes and recreates it. Failures set `state=ERROR` and raise, but nothing durable marks "provision failed, don't retry". | ADE must supply the provisioning record, dedupe, and failure surfacing itself; upstream gives only best-effort re-entrancy. |
| 2 | **Idle-stop with persistent state**: container *stops* after configurable idle window (no session activity, **no viewer**); next need restarts transparently | Upstream has idle-**pause** (`docker pause`, container stays memory-resident) after `idle_pause_minutes`, skipping agent-acquired desktops; `stop` exists but is only manual. Idle input is MCP tool calls only — **viewer connections are not tracked** at all (neither keeping alive nor counted as activity). Restart-on-need is not automatic: tool calls against a paused/stopped desktop error; the caller must `resume`/`start` first (only `create` auto-revives by recreation + snapshot restore). | No idle-*stop* policy, no viewer-activity signal, no transparent restart-on-attach. ADE needs to drive stop/start and track viewer presence itself. |
| 3 | **ADE-held per-desktop credentials injected at MCP attach**, re-issued at attach, rotation as explicit operator action | Upstream credentials are **per-agent** (registry api_key, hashed, or admin token), not per-desktop; desktop scoping is ownership-derived. `reset_agent_key` exists (rotation primitive). The dormant `auth.py` capability tokens can scope `{agent, desktops[], exp}` but are not the wired-in path. Keys are minted by Screenbox's registry, not injected by an external controller — though nothing prevents ADE from registering one agent per bot and holding that key. | Model mismatch: per-agent vs per-desktop. Workable by convention (one registered agent per bot, key held by ADE, passed as `?token=`/header at attach), but upstream has no first-class "issue credential for desktop X at attach time" API; scoped capability tokens exist but are unwired. |
| 4 | **One persistent volume per bot (home + browser profile); deleting the bot deletes desktop + volume** behind explicit confirmation | Matches well: `screenbox-<id>-home` named volume holds home + Chromium profile; `destroy` (confirm-gated) + `delete_data()` removes container, dossier, and volume. Two caveats: state is **also** spread into the shared data volume dossier and server-side `snapshots/<id>/` (deleted by `delete_data`/`delete_snapshots`, but snapshots are a second copy of home state ADE says it doesn't want to own), and auto-snapshot (default every 30 min, plus on pause/destroy) is on by default. | Minor: delete path spans three stores (volume, dossier, snapshots); ADE's "no backup in V1" stance implies disabling upstream's default auto-snapshot/restore behavior, which is config (`auto_snapshot_minutes=0`) plus destroy's `save_snapshot=False`, not a mode. |
| 5 | **Same-host docker/podman** | Docker only: shells out to the `docker` CLI (through the compose socket-proxy or directly), uses `docker pause`, compose v2 layout, `/var/run/docker.sock`. **No podman support anywhere in the tree** (no mention in code, scripts, or docs); docker-proxy allowlist assumes Docker Engine API paths. Podman's docker-compatible API would need testing at minimum; the CLI-subprocess approach is the coupling point. | Podman is unverified/unsupported upstream. |
| 6 | ADE owns lifecycle/policy/presentation; Screenbox owns container + desktop state (§3.4 split) | Compatible: upstream's HTTP API + MCP tools expose all lifecycle verbs an external controller needs (`create/control/destroy/delete-data`, SSE `/api/events` for state changes, `/api/desktop/screenshot` and share links for presentation). Dashboard is optional/pure-UI. | None structurally — but upstream's own idle/auto-snapshot/lease policy engines run unconditionally inside the MCP server, so ADE-as-policy-owner overlaps with upstream policy loops unless they're configured off (idle_pause=0, auto_snapshot=0, lease_ttl=0). |

Other facts relevant to an ADE integration decision (no design implied):

- License: **AGPL-3.0** (ADE §3.5 explicitly closes this as a non-constraint).
- The desktop's browser control plane depends on a bundled Chromium extension + ws-bridge; `desktop_chrome` actions ride CDP through it.
- MCP server is a single Python process holding in-memory desktop/lease state; Streamable HTTP is stateless per request but lease/lock state does not survive server restart.
- Host port exposure defaults to loopback only; multi-host or remote-viewer topologies rely on the dashboard proxy or changing `port_bind_address`.
