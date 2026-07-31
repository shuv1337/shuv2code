import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  codexAppServerArgs,
  codexAppServerSupervisorKey,
  codexExecLaunchArgs,
  codexSessionAppServerArgs,
  resolveCodexLaunchArgs,
  stripCodexListenArgs,
} from "./codexLaunchArgs.ts";

describe("resolveCodexLaunchArgs", () => {
  it("uses SHUV2CODE_CODEX_LAUNCH_ARGS before configured settings", () => {
    NodeAssert.equal(
      resolveCodexLaunchArgs(" --strict-config ", { SHUV2CODE_CODEX_LAUNCH_ARGS: "--enable foo" }),
      "--enable foo",
    );
  });

  it("uses configured settings when SHUV2CODE_CODEX_LAUNCH_ARGS is empty", () => {
    NodeAssert.equal(
      resolveCodexLaunchArgs(" --strict-config ", { SHUV2CODE_CODEX_LAUNCH_ARGS: "   " }),
      "--strict-config",
    );
  });

  it("ignores whitespace-only environment values", () => {
    NodeAssert.equal(resolveCodexLaunchArgs("", { SHUV2CODE_CODEX_LAUNCH_ARGS: "   " }), "");
  });
});

describe("codexAppServerArgs", () => {
  it("returns the app-server command for empty launch args", () => {
    NodeAssert.deepStrictEqual(codexAppServerArgs(""), ["app-server"]);
  });

  it("appends parsed launch args after app-server", () => {
    NodeAssert.deepStrictEqual(codexAppServerArgs("--strict-config --enable foo"), [
      "app-server",
      "--strict-config",
      "--enable",
      "foo",
    ]);
  });
});

describe("codexExecLaunchArgs", () => {
  it("keeps shared codex flags and omits app-server-only flags", () => {
    NodeAssert.deepStrictEqual(
      codexExecLaunchArgs('--strict-config --enable foo --listen off --config model="gpt 5"'),
      ["--strict-config", "--enable", "foo", "--config", "model=gpt 5"],
    );
  });

  it("does not pair value-taking flags with adjacent flags", () => {
    NodeAssert.deepStrictEqual(codexExecLaunchArgs("--config --strict-config --enable --disable"), [
      "--strict-config",
    ]);
  });
});

describe("shared app-server launch identity", () => {
  it("strips user --listen flags", () => {
    NodeAssert.deepStrictEqual(
      stripCodexListenArgs(["--strict-config", "--listen", "off", "--enable", "foo"]),
      ["--strict-config", "--enable", "foo"],
    );
    NodeAssert.deepStrictEqual(stripCodexListenArgs(["--listen=unix:///tmp/x", "--enable", "a"]), [
      "--enable",
      "a",
    ]);
  });

  it("forces a private unix listen path for shared topology", () => {
    NodeAssert.deepStrictEqual(
      codexSessionAppServerArgs(undefined, "--listen off --strict-config", {
        listenUnixPath: "/tmp/shuv2code/codex.sock",
        enableRealtimeConversation: true,
      }),
      [
        "app-server",
        "--strict-config",
        "--listen",
        "unix:///tmp/shuv2code/codex.sock",
        "--enable",
        "realtime_conversation",
      ],
    );
  });

  it("builds a stable supervisor key", () => {
    const a = codexAppServerSupervisorKey({
      binaryPath: "/usr/bin/codex",
      codexHome: "/home/u/.codex",
      launchArgs: "--strict-config",
      enableRealtimeConversation: true,
    });
    const b = codexAppServerSupervisorKey({
      binaryPath: "/usr/bin/codex",
      codexHome: "/home/u/.codex",
      launchArgs: "--strict-config",
      enableRealtimeConversation: true,
    });
    const c = codexAppServerSupervisorKey({
      binaryPath: "/usr/bin/codex",
      codexHome: "/home/u/.codex",
      launchArgs: "--strict-config",
      enableRealtimeConversation: false,
    });
    NodeAssert.equal(a, b);
    NodeAssert.notEqual(a, c);
  });
});
