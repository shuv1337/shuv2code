#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as NetService from "@t3tools/shared/Net";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveChannelIdentity } from "@t3tools/shared/channelIdentity";
import { windowsSystemTar } from "./build-cli-archive.ts";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

export class CliArchiveSmokeError extends Schema.TaggedError<CliArchiveSmokeError>()(
  "CliArchiveSmokeError",
  { step: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `CLI archive smoke test failed while ${this.step}: ${this.detail}`;
  }
}

const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

// A shim that exits before printing still has to say how it was started.
// Release logs were `running s2code-nightly.cmd:` with nothing after the colon.
const formatCommandFailure = (
  executable: string,
  args: ReadonlyArray<string>,
  result: { readonly stdout: string; readonly stderr: string; readonly exitCode: number },
) =>
  [
    `exit ${String(result.exitCode)}`,
    `command: ${JSON.stringify(executable)}`,
    `args: ${JSON.stringify(args)}`,
    `stdout: ${JSON.stringify(result.stdout)}`,
    `stderr: ${JSON.stringify(result.stderr)}`,
  ].join("\n");

const runExecutable = Effect.fn("runExecutable")(function* (
  executable: string,
  args: ReadonlyArray<string>,
  cwd: string,
  env: Readonly<Record<string, string>> = {},
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(executable, args, {
      cwd,
      // Empty PATH: the archive must not reach a system node, and the
      // launcher context must not leak in from a developer shell.
      env: { PATH: "", HOME: cwd, USERPROFILE: cwd, TMPDIR: cwd, TEMP: cwd, ...env },
      extendEnv: false,
    }),
  );
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [collect(child.stdout), collect(child.stderr), child.exitCode.pipe(Effect.map(Number))],
    { concurrency: "unbounded" },
  );
  return { stdout, stderr, exitCode };
});

const smokeCliArchive = Effect.fn("smokeCliArchive")(function* (input: {
  readonly archive: string;
  readonly expectVersion: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scratch = yield* fs.makeTempDirectory({ prefix: "t3-cli-smoke-" });
  // Windows can keep t3.exe locked (EBUSY) for a moment after the server
  // exits. A leftover scratch directory on a CI runner is harmless, so
  // cleanup retries briefly and never fails a smoke test that passed.
  yield* Effect.addFinalizer(() =>
    fs.remove(scratch, { recursive: true }).pipe(
      Effect.retry({ times: 10, schedule: Schedule.spaced("500 millis") }),
      Effect.catch((error) =>
        Effect.logWarning(`[cli-smoke] could not remove ${scratch}: ${error.message}`),
      ),
    ),
  );

  // On Windows the archive is a zip and the Git Bash `tar` on PATH is GNU
  // tar; use the bsdtar Windows ships, which reads both formats.
  const tar = platform === "win32" ? windowsSystemTar() : "tar";
  const extract = yield* spawner
    .spawn(ChildProcess.make(tar, ["-xf", input.archive, "-C", scratch]))
    .pipe(Effect.flatMap((child) => child.exitCode));
  if (Number(extract) !== 0) {
    return yield* new CliArchiveSmokeError({
      step: "extracting the archive",
      detail: `tar exited with ${String(extract)}`,
    });
  }
  const [root] = yield* fs.readDirectory(scratch);
  if (root === undefined) {
    return yield* new CliArchiveSmokeError({
      step: "extracting the archive",
      detail: "the archive was empty",
    });
  }
  const contentDir = path.join(scratch, root);
  const executable = path.join(contentDir, platform === "win32" ? "t3.exe" : "t3");
  for (const required of [executable, path.join(contentDir, "client/index.html")]) {
    if (!(yield* fs.exists(required))) {
      return yield* new CliArchiveSmokeError({
        step: "checking the archive layout",
        detail: `missing ${path.relative(contentDir, required)}`,
      });
    }
  }

  const versionArgs = ["--version"] as const;
  const version = yield* runExecutable(executable, versionArgs, contentDir);
  if (version.exitCode !== 0 || !version.stdout.includes(input.expectVersion)) {
    return yield* new CliArchiveSmokeError({
      step: "running --version",
      detail: formatCommandFailure(executable, versionArgs, version),
    });
  }

  if (platform === "win32") {
    const hostEnv = yield* HostProcess.Environment;
    const systemRoot = hostEnv.SystemRoot ?? hostEnv.WINDIR ?? "C:\\Windows";
    const powershell = path.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const installerHome = path.join(scratch, "installer home");
    const bin = path.join(scratch, "installer bin");
    const cache = path.join(installerHome, "runtime", "versions", input.expectVersion);
    // A Node SEA resolves runtime externals (@cursor/sdk and the rest of the
    // staged node_modules) from the directory that contains the executable.
    // install.ps1 publishes the whole archive root into this cache; t3.exe
    // alone cannot start.
    yield* fs.makeDirectory(path.dirname(cache), { recursive: true });
    yield* fs.copy(contentDir, cache);
    yield* fs.writeFileString(path.join(installerHome, ".product-identity"), "shuv2code\n");
    yield* fs.writeFileString(path.join(cache, ".install-product"), "shuv2code\n");
    yield* fs.writeFileString(path.join(cache, ".install-complete"), `${input.expectVersion}\n`);
    const env = {
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      ComSpec: path.join(systemRoot, "System32", "cmd.exe"),
      PROCESSOR_ARCHITECTURE: (yield* HostProcess.Architecture) === "arm64" ? "ARM64" : "AMD64",
      S2CODE_HOME: installerHome,
      S2CODE_VERSION: input.expectVersion,
      S2CODE_INSTALL_BIN_DIR: bin,
      // The cache is complete; any unexpected download must fail locally.
      S2CODE_RELEASE_BASE_URL: "http://127.0.0.1:1",
    };
    const installArgs = [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(import.meta.dirname, "install.ps1"),
    ];
    const installed = yield* runExecutable(powershell, installArgs, scratch, env);
    if (installed.exitCode !== 0)
      return yield* new CliArchiveSmokeError({
        step: "installing Windows command aliases",
        detail: formatCommandFailure(powershell, installArgs, installed),
      });
    const invalidProbe = ["--not-a-real-option"] as const;
    const invalidDirect = yield* runExecutable(executable, invalidProbe, contentDir);
    if (invalidDirect.exitCode === 0)
      return yield* new CliArchiveSmokeError({
        step: "forwarding Windows command failures",
        detail: [
          "the executable accepted --not-a-real-option",
          formatCommandFailure(executable, invalidProbe, invalidDirect),
        ].join("\n"),
      });
    const command = resolveChannelIdentity(input.expectVersion).executableName;
    // PowerShell 5.1 runs a .cmd by finding cmd.exe on PATH. The cleared
    // smoke PATH makes that launch exit 0 with empty stdout and stderr.
    const shimEnv = {
      ...env,
      PATH: path.join(systemRoot, "System32"),
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
    };
    for (const name of [command, command.replace("s2code", "shuv2code")]) {
      const aliasArgs = [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `& (Join-Path $env:S2CODE_INSTALL_BIN_DIR '${name}.cmd') --version; exit $LASTEXITCODE`,
      ];
      const alias = yield* runExecutable(powershell, aliasArgs, scratch, shimEnv);
      if (alias.exitCode !== 0 || alias.stdout.trim() !== version.stdout.trim())
        return yield* new CliArchiveSmokeError({
          step: `running ${name}.cmd`,
          detail: [
            formatCommandFailure(powershell, aliasArgs, alias),
            `expected stdout: ${JSON.stringify(version.stdout)}`,
          ].join("\n"),
        });
    }
    // `exit $LASTEXITCODE` from Windows PowerShell 5.1 is 0 in this cleared
    // environment, including a direct run of the exe. cmd.exe returns the
    // executable's status, so failure forwarding is checked there.
    const cmd = path.join(systemRoot, "System32", "cmd.exe");
    const driver = path.join(scratch, "smoke-invalid.cmd");
    const aliasPath = path.join(bin, `${command}.cmd`);
    yield* fs.writeFileString(driver, `@echo off\r\n"${aliasPath}" --not-a-real-option\r\n`);
    const invalidArgs = ["/d", "/c", driver] as const;
    const invalid = yield* runExecutable(cmd, invalidArgs, scratch, env);
    if (invalid.exitCode !== invalidDirect.exitCode || invalid.stderr !== invalidDirect.stderr)
      return yield* new CliArchiveSmokeError({
        step: "forwarding Windows command failures",
        detail: [
          formatCommandFailure(cmd, invalidArgs, invalid),
          `expected exit ${String(invalidDirect.exitCode)}`,
          `expected stderr: ${JSON.stringify(invalidDirect.stderr)}`,
        ].join("\n"),
      });
  }

  const net = yield* NetService.NetService;
  const port = yield* net.findAvailablePort(47700);
  const home = path.join(scratch, "home");
  const server = yield* spawner.spawn(
    ChildProcess.make(
      executable,
      ["serve", "--host", "127.0.0.1", "--port", String(port), "--no-browser"],
      {
        cwd: contentDir,
        env: {
          PATH: "",
          HOME: home,
          USERPROFILE: home,
          TMPDIR: scratch,
          TEMP: scratch,
          S2CODE_HOME: home,
        },
        extendEnv: false,
      },
    ),
  );
  const output = yield* Effect.forkScoped(
    Effect.all([collect(server.stdout), collect(server.stderr)]),
  );
  const httpClient = yield* HttpClient.HttpClient;
  // A request that connects while the server is still initializing can hang,
  // so each probe gets its own deadline, like the SSH readiness probe.
  const probe = httpClient.execute(HttpClientRequest.get(`http://127.0.0.1:${String(port)}/`)).pipe(
    Effect.map((response) => response.status === 200),
    Effect.timeout(Duration.seconds(2)),
    Effect.orElseSucceed(() => false),
  );
  const pollUntilReady = Effect.gen(function* () {
    while (!(yield* probe)) {
      yield* Effect.sleep(Duration.millis(250));
    }
    return true;
  });
  const ready = yield* pollUntilReady.pipe(
    Effect.timeout(Duration.seconds(30)),
    Effect.orElseSucceed(() => false),
  );
  yield* server.kill({ killSignal: "SIGTERM" }).pipe(Effect.ignore);
  yield* server.exitCode.pipe(Effect.timeout(Duration.seconds(10)), Effect.ignore);
  const [stdout, stderr] = yield* Fiber.join(output).pipe(
    Effect.timeout(Duration.seconds(5)),
    Effect.orElseSucceed(() => ["", ""] as const),
  );
  if (!ready) {
    return yield* new CliArchiveSmokeError({
      step: "serving from the extracted archive",
      detail: `no 200 from / within 30s\n${stdout}${stderr}`,
    });
  }
  yield* Effect.log(`[cli-smoke] ${root}: --version passed and serve answered on ${String(port)}.`);
});

const command = Command.make(
  "smoke-cli-archive",
  {
    archive: Flag.String("archive"),
    expectVersion: Flag.String("expect-version"),
  },
  (input) => smokeCliArchive(input).pipe(Effect.scoped),
).pipe(Command.withDescription("Extract a CLI archive and run its executable."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Logger.layer([Logger.consolePretty()]),
        NodeServices.layer,
        NetService.layer,
        FetchHttpClient.layer,
      ),
    ),
    NodeRuntime.runMain,
  );
}
