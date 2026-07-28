import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import { OPENCODE_MAINTENANCE_DEFINITION } from "./Drivers/OpenCodeDriver.ts";
import { detectOpenCodeProtocolFromVersionOutput } from "./opencodeRuntime.ts";
import { resolvePackageManagedProviderMaintenance } from "./providerMaintenance.ts";
import {
  openCodeV2ChannelFromVersion,
  openCodeV2ServiceRegistrationFileName,
  resolveOpenCodeV2ServiceRegistrationPath,
} from "./opencodeV2Service.ts";

/**
 * Local shuvcode / integration-v2 fork fixtures.
 * Kept out of the generic OpenCode V2 PR surface so upstream PRs do not carry
 * fork branding; the production path already treats 0.0.0-<channel>-* as V2.
 */
describe("shuvcode OpenCode V2 fork compatibility", () => {
  it("detects shuvcode integration-v2 version output as V2", () => {
    NodeAssert.equal(
      detectOpenCodeProtocolFromVersionOutput("shuvcode v0.0.0-integration-v2-202607220047\n"),
      "v2",
    );
  });

  it("maps integration-v2 channel registration the same way the live fork does", () => {
    NodeAssert.equal(
      openCodeV2ChannelFromVersion("0.0.0-integration-v2-202607220047"),
      "integration-v2",
    );
    NodeAssert.equal(
      openCodeV2ServiceRegistrationFileName("0.0.0-integration-v2-202607220047"),
      "service-integration-v2.json",
    );
    NodeAssert.equal(
      resolveOpenCodeV2ServiceRegistrationPath({
        version: "0.0.0-integration-v2-202607220047",
        environment: { XDG_STATE_HOME: "/tmp/xdg-state" },
      }),
      "/tmp/xdg-state/opencode/service-integration-v2.json",
    );
  });

  it("tracks shuvcode npm releases for provider update checks", () => {
    NodeAssert.equal(OPENCODE_MAINTENANCE_DEFINITION.npmPackageName, "shuvcode");
    NodeAssert.equal(OPENCODE_MAINTENANCE_DEFINITION.homebrewFormula, null);
    NodeAssert.equal(OPENCODE_MAINTENANCE_DEFINITION.nativeUpdate, null);
  });

  it("resolves shuvcode update commands for package-managed installs", () => {
    const bareCommand = resolvePackageManagedProviderMaintenance(OPENCODE_MAINTENANCE_DEFINITION, {
      binaryPath: "shuvcode",
    });
    NodeAssert.equal(bareCommand.packageName, "shuvcode");
    NodeAssert.equal(bareCommand.update?.command, "npm install -g shuvcode@latest");

    const bunGlobal = resolvePackageManagedProviderMaintenance(OPENCODE_MAINTENANCE_DEFINITION, {
      binaryPath: "/home/user/.bun/bin/shuvcode",
      resolvedCommandPath: "/home/user/.bun/bin/shuvcode",
    });
    NodeAssert.equal(bunGlobal.update?.command, "bun i -g shuvcode@latest");

    const npmGlobal = resolvePackageManagedProviderMaintenance(OPENCODE_MAINTENANCE_DEFINITION, {
      binaryPath: "/home/user/.npm-global/bin/shuvcode",
      resolvedCommandPath: "/home/user/.npm-global/bin/shuvcode",
      realCommandPath: "/home/user/.npm-global/lib/node_modules/shuvcode/bin/launcher.mjs",
    });
    NodeAssert.equal(npmGlobal.update?.command, "npm install -g shuvcode@latest");
  });

  it("keeps version advisories on shuvcode for manual installs without an update command", () => {
    const manualInstall = resolvePackageManagedProviderMaintenance(
      OPENCODE_MAINTENANCE_DEFINITION,
      {
        binaryPath: "/home/user/.local/bin/shuvcode",
        resolvedCommandPath: "/home/user/.local/bin/shuvcode",
      },
    );
    NodeAssert.equal(manualInstall.packageName, "shuvcode");
    NodeAssert.equal(manualInstall.update, null);
  });
});
