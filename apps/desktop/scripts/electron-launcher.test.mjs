import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import {
  MAC_MICROPHONE_USAGE_DESCRIPTION,
  makeDevelopmentLauncherScript,
  resolveElectronBinaryPath,
  resolveMacLauncherIconPaths,
  resolveMacLauncherPaths,
} from "./electron-launcher.mjs";

NodeTest.describe("electron development launcher", () => {
  NodeTest.it("uses captured values only as fallbacks for a live runner environment", () => {
    const script = makeDevelopmentLauncherScript({
      electronBinaryPath: "/repo/node_modules/electron/Electron",
      mainEntryPath: "/repo/apps/desktop/dist-electron/main.cjs",
      desktopRoot: "/repo/apps/desktop",
      environment: {
        VITE_DEV_SERVER_URL: "http://127.0.0.1:8526",
        SHUV2CODE_PORT: "16566",
        SHUV2CODE_HOME: "/tmp/shuv2code",
      },
    });

    NodeAssert.match(
      script,
      /if \[ -z "\$\{VITE_DEV_SERVER_URL:-\}" \]; then export VITE_DEV_SERVER_URL='http:\/\/127\.0\.0\.1:8526'; fi/,
    );
    NodeAssert.doesNotMatch(script, /\nexport VITE_DEV_SERVER_URL=/);
    NodeAssert.match(
      script,
      /exec '\/repo\/node_modules\/electron\/Electron' --shuv2code-dev-root='\/repo\/apps\/desktop' '\/repo\/apps\/desktop\/dist-electron\/main\.cjs' "\$@"/,
    );
  });

  NodeTest.it("repairs Electron before loading the package entrypoint", () => {
    const calls = [];
    const electronPath = resolveElectronBinaryPath({
      ensureRuntime: () => {
        calls.push("ensure");
      },
      createRequire: () => (specifier) => {
        calls.push(`require:${specifier}`);
        return "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron";
      },
      moduleUrl: import.meta.url,
    });

    NodeAssert.strictEqual(
      electronPath,
      "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    );
    NodeAssert.deepStrictEqual(calls, ["ensure", "require:electron"]);
  });

  NodeTest.it("keeps the native Electron executable name inside the branded macOS bundle", () => {
    const paths = resolveMacLauncherPaths(
      "/repo/apps/desktop/.electron-runtime/shuv2code (Dev).app",
      "shuv2code (Dev)",
    );

    NodeAssert.strictEqual(paths.launcherExecutableName, "shuv2code (Dev) Launcher");
    NodeAssert.strictEqual(
      paths.launcherBinaryPath,
      "/repo/apps/desktop/.electron-runtime/shuv2code (Dev).app/Contents/MacOS/shuv2code (Dev) Launcher",
    );
    NodeAssert.strictEqual(
      paths.runtimeElectronBinaryPath,
      "/repo/apps/desktop/.electron-runtime/shuv2code (Dev).app/Contents/MacOS/Electron",
    );

    const script = makeDevelopmentLauncherScript({
      electronBinaryPath: paths.runtimeElectronBinaryPath,
      mainEntryPath: "/repo/apps/desktop/dist-electron/main.cjs",
      desktopRoot: "/repo/apps/desktop",
      environment: {},
    });
    NodeAssert.match(
      script,
      /exec '\/repo\/apps\/desktop\/\.electron-runtime\/shuv2code \(Dev\)\.app\/Contents\/MacOS\/Electron'/,
    );
    NodeAssert.doesNotMatch(script, /node_modules\/electron/);
  });

  NodeTest.it("declares why the development bundle needs microphone access", () => {
    NodeAssert.strictEqual(
      MAC_MICROPHONE_USAGE_DESCRIPTION,
      "shuv2code needs microphone access for real-time voice control.",
    );
  });

  NodeTest.it("derives launcher icons from canonical development and production assets", () => {
    const development = resolveMacLauncherIconPaths("/runtime", true);
    const production = resolveMacLauncherIconPaths("/runtime", false);

    NodeAssert.match(development.sourceIconPath, /assets\/dev\/blueprint-macos-1024\.png$/);
    NodeAssert.equal(development.generatedIconPath, "/runtime/icon-dev.icns");
    NodeAssert.match(production.sourceIconPath, /assets\/prod\/black-macos-1024\.png$/);
    NodeAssert.equal(production.generatedIconPath, "/runtime/icon-prod.icns");
  });
});
