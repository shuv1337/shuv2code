# Workspace layout

> For maintainers. Using shuv2code? See [docs/user](../user/).

A pnpm workspace driven by [vite-plus](https://vite.plus) (`vp`). See [scripts.md](./scripts.md) for
the task commands.

## apps

- `apps/server` (`shuv2code`): the execution runtime and the published CLI. Owns orchestration, provider
  drivers, checkpointing, VCS, terminals, filesystem access, auth, and the HTTP + WebSocket surface.
  Also serves the built web app.
- `apps/web` (`@shuv2code/web`): React + Vite UI. Consumes the shared client runtime and adds routing,
  components, and web-specific platform layers.
- `apps/desktop` (`@shuv2code/desktop`): Electron shell. Supervises a desktop-scoped `shuv2code` backend,
  loads the web bundle over the `shuv2code://` protocol, and owns SSH-managed remote environments.
- `apps/mobile` (`@shuv2code/mobile`): Expo/React Native client. Same client runtime composition as
  web, different platform layer and UI.
- `apps/marketing` (`@shuv2code/marketing`): Astro marketing site.

## packages

- `packages/contracts` (`@shuv2code/contracts`): shared Effect Schema definitions. RPC group,
  orchestration commands/events/read model, auth scopes, environment descriptors, settings.
- `packages/shared` (`@shuv2code/shared`): framework-agnostic utilities used by server and clients
  (`DrainableWorker`, git and source-control helpers, relay auth and signing, DPoP, semver, logging,
  observability, and more).
- `packages/client-runtime` (`@shuv2code/client-runtime`): connection lifecycle, authorization, RPC
  session, environment registry, and Atom-based domain state shared by web and mobile. See its
  [README](../../packages/client-runtime/README.md).
- `packages/ssh` (`@shuv2code/ssh`): SSH config parsing, auth prompts, command execution, and the
  tunnel/environment manager behind desktop-managed SSH environments.
- `packages/tailscale` (`@shuv2code/tailscale`): Tailscale CLI wrapper, including the
  `ensureTailscaleServe` / `disableTailscaleServe` serve lifecycle the server drives.
- `packages/effect-acp` (`effect-acp`): Effect client and agent implementation of the Agent Client
  Protocol, used by ACP-speaking provider drivers.
- `packages/effect-codex-app-server` (`effect-codex-app-server`): Effect client for the
  `codex app-server` JSON-RPC protocol.

## infra

- `infra/relay` (`shuv2code-relay`): the hosted shuv2code connect relay, deployed with Alchemy. Handles
  environment discovery, cloud-side records, and mobile notifications. It is not in the hot path;
  after connect, client traffic goes directly to the environment. See
  [shuv2code-connect.md](./shuv2code-connect.md).

## Other top-level directories

- `scripts/`: workspace tooling run through `vp run`. Dev runner, desktop artifact builds, release
  helpers, mobile static checks and showcase capture, update-manifest merging.
- `assets/`: brand and app icon sources per channel (`dev`, `nightly`, `prod`).
- `patches/`: pnpm patches for pinned upstream dependencies.
- `oxlint-plugin-shuv2code/`: repo-specific lint rules.
- `experiments/`: throwaway prototypes. Not part of the shipped build.
- `docs/`: this documentation tree.

## Import conventions

`@shuv2code/shared` and `@shuv2code/client-runtime` use explicit subpath exports with no barrel index and
no root export. Import the narrow path (`@shuv2code/shared/DrainableWorker`,
`@shuv2code/client-runtime/state/threads`) rather than the package root. Files that are not exported
are implementation details. `@shuv2code/contracts` does export a root alongside `./settings` and
`./relay`.
