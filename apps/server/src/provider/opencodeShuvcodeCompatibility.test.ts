// @effect-diagnostics nodeBuiltinImport:off

import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, it } from "vite-plus/test";

import { OPENCODE_V2_MAINTENANCE_DEFINITION } from "./Drivers/OpenCodeV2Driver.ts";
import { detectOpenCodeProtocolFromVersionOutput } from "./opencodeRuntime.ts";
import { resolvePackageManagedProviderMaintenance } from "./providerMaintenance.ts";
import {
  discoverOpenCodeV2Service,
  openCodeV2ChannelFromVersion,
  openCodeV2ServiceRegistrationFileName,
  orderOpenCodeV2RegistrationCandidates,
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
    NodeAssert.equal(OPENCODE_V2_MAINTENANCE_DEFINITION.npmPackageName, "shuvcode");
    NodeAssert.equal(OPENCODE_V2_MAINTENANCE_DEFINITION.homebrewFormula, null);
    NodeAssert.equal(OPENCODE_V2_MAINTENANCE_DEFINITION.nativeUpdate, null);
  });

  it("resolves shuvcode update commands for package-managed installs", () => {
    const bareCommand = resolvePackageManagedProviderMaintenance(OPENCODE_V2_MAINTENANCE_DEFINITION, {
      binaryPath: "shuvcode",
    });
    NodeAssert.equal(bareCommand.packageName, "shuvcode");
    NodeAssert.equal(
      bareCommand.update?.command,
      "npm install -g --allow-scripts=shuvcode shuvcode@latest",
    );

    const bunGlobal = resolvePackageManagedProviderMaintenance(OPENCODE_V2_MAINTENANCE_DEFINITION, {
      binaryPath: "/home/user/.bun/bin/shuvcode",
      resolvedCommandPath: "/home/user/.bun/bin/shuvcode",
    });
    NodeAssert.equal(bunGlobal.update?.command, "bun i -g shuvcode@latest");

    const npmGlobal = resolvePackageManagedProviderMaintenance(OPENCODE_V2_MAINTENANCE_DEFINITION, {
      binaryPath: "/home/user/.npm-global/bin/shuvcode",
      resolvedCommandPath: "/home/user/.npm-global/bin/shuvcode",
      realCommandPath: "/home/user/.npm-global/lib/node_modules/shuvcode/bin/launcher.mjs",
    });
    NodeAssert.equal(
      npmGlobal.update?.command,
      "npm install -g --allow-scripts=shuvcode shuvcode@latest",
    );
  });

  it("keeps version advisories on shuvcode for manual installs without an update command", () => {
    const manualInstall = resolvePackageManagedProviderMaintenance(
      OPENCODE_V2_MAINTENANCE_DEFINITION,
      {
        binaryPath: "/home/user/.local/bin/shuvcode",
        resolvedCommandPath: "/home/user/.local/bin/shuvcode",
      },
    );
    NodeAssert.equal(manualInstall.packageName, "shuvcode");
    NodeAssert.equal(manualInstall.update, null);
  });

  it("detects sync-upstream-v2 dev builds as V2", () => {
    NodeAssert.equal(
      detectOpenCodeProtocolFromVersionOutput("shuvcode v0.0.0-sync-upstream-v2-202607270949\n"),
      "v2",
    );
    NodeAssert.equal(
      openCodeV2ChannelFromVersion("0.0.0-sync-upstream-v2-202607270949"),
      "sync-upstream-v2",
    );
  });

  it("prefers the derived channel registration, then stable, then local last", () => {
    NodeAssert.deepEqual(
      orderOpenCodeV2RegistrationCandidates(
        ["service-local.json", "frecency.jsonl", "service-integration-v2.json", "service.json"],
        "0.0.0-integration-v2-202607241824",
      ),
      ["service-integration-v2.json", "service.json", "service-local.json"],
    );
  });

  it("maps published alpha builds to service.json and prefers it over service-local", () => {
    // Live failure: shuvcode 2.0.0-alpha-4 derived service-2.0.0-alpha-4.json
    // (missing), then alphabetical scan attached to a bare local service that
    // only exposed OpenCode Zen models instead of the user's authenticated
    // service.json inventory.
    NodeAssert.equal(openCodeV2ChannelFromVersion("2.0.0-alpha-4"), "latest");
    NodeAssert.equal(openCodeV2ServiceRegistrationFileName("2.0.0-alpha-4"), "service.json");
    NodeAssert.deepEqual(
      orderOpenCodeV2RegistrationCandidates(
        ["service-local.json", "service.json", "frecency.jsonl"],
        "2.0.0-alpha-4",
      ),
      ["service.json", "service-local.json"],
    );
  });

  it("attaches to a healthy service registered under a previous dev channel", async () => {
    // Reproduces the live-fork failure mode: the shuvcode binary was rebuilt
    // onto a new channel (sync-upstream-v2) while the running background
    // service still registers under the previous channel (integration-v2).
    const stateHome = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "shuvcode-v2-state-"));
    const serviceDir = NodePath.join(stateHome, "opencode");
    await NodeFSP.mkdir(serviceDir, { recursive: true });

    const staleVersion = "0.0.0-integration-v2-202607241824";
    const server = NodeHttp.createServer((request, response) => {
      if (request.url === "/api/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ healthy: true, version: staleVersion, pid: process.pid }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    NodeAssert.ok(address && typeof address === "object");

    try {
      const url = `http://127.0.0.1:${address.port}`;
      await NodeFSP.writeFile(
        NodePath.join(serviceDir, "service-integration-v2.json"),
        JSON.stringify({ url, pid: process.pid, version: staleVersion }),
      );

      const endpoint = await discoverOpenCodeV2Service({
        version: "0.0.0-sync-upstream-v2-202607270949",
        environment: { XDG_STATE_HOME: stateHome },
      });
      NodeAssert.ok(endpoint, "expected fallback discovery to find the stale-channel service");
      NodeAssert.equal(endpoint.url, url);
      NodeAssert.equal(endpoint.version, staleVersion);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await NodeFSP.rm(stateHome, { recursive: true, force: true });
    }
  });

  it("discovers the stable service for alpha builds instead of a zen-only local service", async () => {
    const stateHome = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "shuvcode-v2-alpha-"));
    const serviceDir = NodePath.join(stateHome, "opencode");
    await NodeFSP.mkdir(serviceDir, { recursive: true });

    const stableServer = NodeHttp.createServer((request, response) => {
      if (request.url === "/api/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ healthy: true, version: "2.0.0-alpha-4", pid: process.pid }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    const localServer = NodeHttp.createServer((request, response) => {
      if (request.url === "/api/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ healthy: true, version: "local", pid: process.pid }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await Promise.all([
      new Promise<void>((resolve) => stableServer.listen(0, "127.0.0.1", resolve)),
      new Promise<void>((resolve) => localServer.listen(0, "127.0.0.1", resolve)),
    ]);
    const stableAddress = stableServer.address();
    const localAddress = localServer.address();
    NodeAssert.ok(stableAddress && typeof stableAddress === "object");
    NodeAssert.ok(localAddress && typeof localAddress === "object");

    try {
      const stableUrl = `http://127.0.0.1:${stableAddress.port}`;
      const localUrl = `http://127.0.0.1:${localAddress.port}`;
      await NodeFSP.writeFile(
        NodePath.join(serviceDir, "service.json"),
        JSON.stringify({ url: stableUrl, pid: process.pid, version: "2.0.0-alpha-4" }),
      );
      await NodeFSP.writeFile(
        NodePath.join(serviceDir, "service-local.json"),
        JSON.stringify({ url: localUrl, pid: process.pid, version: "local" }),
      );

      const endpoint = await discoverOpenCodeV2Service({
        version: "2.0.0-alpha-4",
        environment: { XDG_STATE_HOME: stateHome },
      });
      NodeAssert.ok(endpoint, "expected alpha build to discover the stable service");
      NodeAssert.equal(endpoint.url, stableUrl);
      NodeAssert.equal(endpoint.version, "2.0.0-alpha-4");
    } finally {
      await Promise.all([
        new Promise<void>((resolve) => stableServer.close(() => resolve())),
        new Promise<void>((resolve) => localServer.close(() => resolve())),
      ]);
      await NodeFSP.rm(stateHome, { recursive: true, force: true });
    }
  });

  it("accepts a same-channel registration whose dev stamp is older than the binary", async () => {
    const stateHome = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "shuvcode-v2-stamp-"));
    const serviceDir = NodePath.join(stateHome, "opencode");
    await NodeFSP.mkdir(serviceDir, { recursive: true });

    const serviceVersion = "0.0.0-sync-upstream-v2-202607260000";
    const server = NodeHttp.createServer((request, response) => {
      if (request.url === "/api/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ healthy: true, version: serviceVersion, pid: process.pid }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    NodeAssert.ok(address && typeof address === "object");

    try {
      const url = `http://127.0.0.1:${address.port}`;
      await NodeFSP.writeFile(
        NodePath.join(serviceDir, "service-sync-upstream-v2.json"),
        JSON.stringify({ url, pid: process.pid, version: serviceVersion }),
      );

      const endpoint = await discoverOpenCodeV2Service({
        version: "0.0.0-sync-upstream-v2-202607270949",
        environment: { XDG_STATE_HOME: stateHome },
      });
      NodeAssert.ok(endpoint, "expected stamp-mismatched same-channel service to be accepted");
      NodeAssert.equal(endpoint.url, url);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await NodeFSP.rm(stateHome, { recursive: true, force: true });
    }
  });
});
