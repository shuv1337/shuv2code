import { tokenizeCliArgs } from "@shuv2code/shared/cliArgs";

export const SHUV2CODE_CODEX_LAUNCH_ARGS_ENV = "SHUV2CODE_CODEX_LAUNCH_ARGS";

export const resolveCodexLaunchArgs = (
  launchArgs?: string,
  environment: NodeJS.ProcessEnv = process.env,
) => environment[SHUV2CODE_CODEX_LAUNCH_ARGS_ENV]?.trim() || launchArgs?.trim() || "";

export const codexLaunchArgv = (launchArgs?: string): ReadonlyArray<string> =>
  tokenizeCliArgs(launchArgs);

export const codexAppServerArgs = (launchArgs?: string) => [
  "app-server",
  ...codexLaunchArgv(launchArgs),
];

export const codexExecLaunchArgs = (launchArgs?: string) => {
  const args = codexLaunchArgv(launchArgs);
  const execArgs: Array<string> = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (arg === "--strict-config" || arg.startsWith("--config=") || arg.startsWith("-c=")) {
      execArgs.push(arg);
    } else if (arg === "--config" || arg === "-c" || arg === "--enable" || arg === "--disable") {
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith("-")) {
        execArgs.push(arg, value);
        index++;
      }
    } else if (arg.startsWith("--enable=") || arg.startsWith("--disable=")) {
      execArgs.push(arg);
    }
  }

  return execArgs;
};

/**
 * Strip user-supplied `--listen` tokens so a shared supervisor can own the
 * control socket without colliding with ambient launch args.
 */
export const stripCodexListenArgs = (args: ReadonlyArray<string>): ReadonlyArray<string> => {
  const next: Array<string> = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "--listen") {
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith("-")) index++;
      continue;
    }
    if (arg.startsWith("--listen=")) continue;
    next.push(arg);
  }
  return next;
};

export const codexSessionAppServerArgs = (
  appServerArgs: ReadonlyArray<string> | undefined,
  launchArgs: string | undefined,
  options: {
    readonly enableRealtimeConversation?: boolean;
    /** When set, forces a private Unix listen path and strips user --listen. */
    readonly listenUnixPath?: string;
  } = {},
) => {
  const launchAppServerArgs = codexAppServerArgs(launchArgs);
  const merged = appServerArgs ? [...launchAppServerArgs, ...appServerArgs] : launchAppServerArgs;
  const withoutListen =
    options.listenUnixPath !== undefined ? stripCodexListenArgs(merged) : merged;
  const withListen =
    options.listenUnixPath !== undefined
      ? [...withoutListen, "--listen", `unix://${options.listenUnixPath}`]
      : withoutListen;
  return options.enableRealtimeConversation
    ? [...withListen, "--enable", "realtime_conversation"]
    : withListen;
};

/** Stable supervisor key material for one Codex home / binary / launch identity. */
export const codexAppServerSupervisorKey = (input: {
  readonly binaryPath: string;
  readonly codexHome: string;
  readonly launchArgs: string;
  readonly enableRealtimeConversation: boolean;
}): string =>
  [
    input.binaryPath,
    input.codexHome,
    input.launchArgs.trim(),
    input.enableRealtimeConversation ? "realtime" : "text",
  ].join("\u001f");
