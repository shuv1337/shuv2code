#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

/**
 * Rebuilds the server bundle and restarts the repo-backed `shuv2code.service`
 * systemd user unit in one step.
 *
 * The boot service loads `apps/server/dist/bin.mjs` once at startup, so a
 * rebuilt dist on disk changes nothing until the unit restarts. Rebuilding
 * without restarting leaves the service running stale code indefinitely —
 * exactly the drift this script exists to prevent. It refuses to touch units
 * that do not point at this checkout's dist (for example release-managed
 * installs, which are updated with `shuv2code service update` instead).
 */

export const BOOT_SERVICE_UNIT = "shuv2code.service";
export const SERVER_DIST_RELATIVE_PATH = "apps/server/dist/bin.mjs";

/** Delay between the two post-restart health samples. Must exceed the unit's
 * `RestartSec=5` so an instantly-crashing service is observed as a pid change
 * (crash loop) instead of a single healthy-looking sample. */
export const RESTART_VERIFICATION_DELAY = Duration.seconds(7);

export interface BootServiceState {
  readonly loadState: string;
  readonly activeState: string;
  readonly mainPid: number;
  readonly execStart: string;
}

export type BootServiceRedeployDecision =
  | { readonly kind: "redeploy"; readonly previousPid: number }
  | { readonly kind: "not-installed" }
  | { readonly kind: "foreign-unit"; readonly execStart: string };

export type RestartVerdict =
  | { readonly ok: true; readonly pid: number }
  | { readonly ok: false; readonly reason: "inactive" | "pid-unchanged" | "crash-loop" };

export class BootServiceCommandError extends Schema.TaggedErrorClass<BootServiceCommandError>()(
  "BootServiceCommandError",
  {
    command: Schema.String,
    operation: Schema.Literals(["spawn", "communicate", "exit"]),
    exitCode: Schema.optional(Schema.Number),
    stderr: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const detail = this.stderr && this.stderr.length > 0 ? `\n${this.stderr.trim()}` : "";
    return `Command "${this.command}" failed during "${this.operation}"${
      this.exitCode === undefined ? "" : ` with exit code ${this.exitCode}`
    }.${detail}`;
  }
}

export class BootServiceUnitNotInstalledError extends Schema.TaggedErrorClass<BootServiceUnitNotInstalledError>()(
  "BootServiceUnitNotInstalledError",
  { unit: Schema.String },
) {
  override get message(): string {
    return `Systemd user unit "${this.unit}" is not installed on this host. Nothing to restart; run with --build-only to only rebuild the dist.`;
  }
}

export class BootServiceUnitMismatchError extends Schema.TaggedErrorClass<BootServiceUnitMismatchError>()(
  "BootServiceUnitMismatchError",
  {
    unit: Schema.String,
    execStart: Schema.String,
    distPath: Schema.String,
  },
) {
  override get message(): string {
    return `Systemd user unit "${this.unit}" does not run this checkout's dist (${this.distPath}). It is managed elsewhere (ExecStart: ${this.execStart}); use \`shuv2code service update\` for release-managed installs.`;
  }
}

export class BootServiceRestartVerificationError extends Schema.TaggedErrorClass<BootServiceRestartVerificationError>()(
  "BootServiceRestartVerificationError",
  {
    unit: Schema.String,
    reason: Schema.Literals(["inactive", "pid-unchanged", "crash-loop"]),
    previousPid: Schema.Number,
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "inactive":
        return `Systemd user unit "${this.unit}" is not active after restart. Check the boot-service log for startup failures.`;
      case "pid-unchanged":
        return `Systemd user unit "${this.unit}" still runs pid ${this.previousPid} after restart; the restart did not take effect.`;
      case "crash-loop":
        return `Systemd user unit "${this.unit}" restarted again shortly after the redeploy restart; the new build appears to crash on startup. Check the boot-service log.`;
    }
  }
}

/**
 * Parses `systemctl show` KEY=VALUE output. Values may themselves contain
 * `=` (ExecStart does), so only the first separator splits.
 */
export function parseSystemdShow(output: string): Record<string, string> {
  const properties: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    properties[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return properties;
}

export function toBootServiceState(properties: Record<string, string>): BootServiceState {
  const parsedPid = Number.parseInt(properties["ExecMainPID"] ?? "", 10);
  return {
    loadState: properties["LoadState"] ?? "",
    activeState: properties["ActiveState"] ?? "",
    mainPid: Number.isFinite(parsedPid) ? parsedPid : 0,
    execStart: properties["ExecStart"] ?? "",
  };
}

/**
 * Only two unit shapes are redeployable from here: a unit whose ExecStart
 * references this checkout's dist bundle. Anything else is either absent or
 * owned by another install mechanism and must not be restarted by a repo
 * build script.
 */
export function decideBootServiceRedeploy(
  state: BootServiceState,
  distPath: string,
): BootServiceRedeployDecision {
  if (state.loadState !== "loaded") {
    return { kind: "not-installed" };
  }
  if (!state.execStart.includes(distPath)) {
    return { kind: "foreign-unit", execStart: state.execStart };
  }
  return { kind: "redeploy", previousPid: state.mainPid };
}

/**
 * Two samples taken RESTART_VERIFICATION_DELAY apart. A healthy redeploy is
 * active in both with one stable pid that differs from the pre-restart pid.
 * A pid change between samples means systemd already restarted the fresh
 * process — the new build is crash-looping.
 */
export function evaluateRestartSamples(
  previousPid: number,
  first: BootServiceState,
  second: BootServiceState,
): RestartVerdict {
  if (first.activeState !== "active" || second.activeState !== "active") {
    return { ok: false, reason: "inactive" };
  }
  if (first.mainPid !== second.mainPid) {
    return { ok: false, reason: "crash-loop" };
  }
  if (previousPid > 0 && second.mainPid === previousPid) {
    return { ok: false, reason: "pid-unchanged" };
  }
  return { ok: true, pid: second.mainPid };
}

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const runCommand = Effect.fn("runCommand")(function* (
  command: string,
  args: ReadonlyArray<string>,
  options?: { readonly cwd?: string },
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const rendered = [command, ...args].join(" ");
  const child = yield* spawner
    .spawn(ChildProcess.make(command, [...args], options?.cwd ? { cwd: options.cwd } : {}))
    .pipe(
      Effect.mapError(
        (cause) => new BootServiceCommandError({ command: rendered, operation: "spawn", cause }),
      ),
    );
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectStreamAsString(child.stdout),
      collectStreamAsString(child.stderr),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.mapError(
      (cause) =>
        new BootServiceCommandError({ command: rendered, operation: "communicate", cause }),
    ),
  );
  if (exitCode !== 0) {
    return yield* new BootServiceCommandError({
      command: rendered,
      operation: "exit",
      exitCode,
      stderr,
    });
  }
  return stdout;
});

const readBootServiceState = Effect.fn("readBootServiceState")(function* () {
  const output = yield* runCommand("systemctl", [
    "--user",
    "show",
    BOOT_SERVICE_UNIT,
    "--property=LoadState,ActiveState,ExecMainPID,ExecStart",
  ]);
  return toBootServiceState(parseSystemdShow(output));
});

const buildServerDist = Effect.fn("buildServerDist")(function* (rootDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverDir = path.join(rootDir, "apps", "server");
  const vpBinary = path.join(serverDir, "node_modules", ".bin", "vp");
  if (!(yield* fs.exists(vpBinary))) {
    return yield* new BootServiceCommandError({
      command: `${vpBinary} pack`,
      operation: "spawn",
      stderr: "vp binary not found; run pnpm install first.",
    });
  }
  yield* Console.log("Building apps/server dist (vp pack)...");
  const output = yield* runCommand(vpBinary, ["pack"], { cwd: serverDir });
  if (output.trim().length > 0) {
    yield* Console.log(output.trim());
  }
});

export interface BootServiceRedeployOptions {
  readonly rootDir?: string | undefined;
  readonly buildOnly?: boolean | undefined;
}

export const redeployBootService = Effect.fn("redeployBootService")(function* (
  options: BootServiceRedeployOptions = {},
) {
  const path = yield* Path.Path;
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const distPath = path.join(rootDir, ...SERVER_DIST_RELATIVE_PATH.split("/"));

  if (options.buildOnly ?? false) {
    yield* buildServerDist(rootDir);
    yield* Console.log("Build complete. Skipping boot service restart (--build-only).");
    return;
  }

  // Decide before building so a foreign or missing unit fails fast, without
  // mutating the dist that a differently-managed service might point at.
  const before = yield* readBootServiceState();
  const decision = decideBootServiceRedeploy(before, distPath);
  if (decision.kind === "not-installed") {
    return yield* new BootServiceUnitNotInstalledError({ unit: BOOT_SERVICE_UNIT });
  }
  if (decision.kind === "foreign-unit") {
    return yield* new BootServiceUnitMismatchError({
      unit: BOOT_SERVICE_UNIT,
      execStart: decision.execStart,
      distPath,
    });
  }

  yield* buildServerDist(rootDir);

  yield* Console.log(`Restarting ${BOOT_SERVICE_UNIT}...`);
  yield* runCommand("systemctl", ["--user", "restart", BOOT_SERVICE_UNIT]);

  const first = yield* readBootServiceState();
  yield* Effect.sleep(RESTART_VERIFICATION_DELAY);
  const second = yield* readBootServiceState();
  const verdict = evaluateRestartSamples(decision.previousPid, first, second);
  if (!verdict.ok) {
    return yield* new BootServiceRestartVerificationError({
      unit: BOOT_SERVICE_UNIT,
      reason: verdict.reason,
      previousPid: decision.previousPid,
    });
  }
  yield* Console.log(`${BOOT_SERVICE_UNIT} is active on the new build (pid ${verdict.pid}).`);
});

export const redeployBootServiceCommand = Command.make(
  "redeploy-boot-service",
  {
    root: Flag.string("root").pipe(
      Flag.withDescription("Repo root containing apps/server. Defaults to the current directory."),
      Flag.optional,
    ),
    buildOnly: Flag.boolean("build-only").pipe(
      Flag.withDescription("Rebuild the server dist without touching the systemd unit."),
      Flag.withDefault(false),
    ),
  },
  ({ root, buildOnly }) =>
    redeployBootService({ rootDir: Option.getOrUndefined(root), buildOnly }).pipe(Effect.scoped),
).pipe(
  Command.withDescription(
    "Rebuild apps/server dist and restart the repo-backed shuv2code boot service.",
  ),
);

if (import.meta.main) {
  Command.run(redeployBootServiceCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
