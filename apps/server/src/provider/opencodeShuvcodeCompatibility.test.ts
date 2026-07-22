import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import { detectOpenCodeProtocolFromVersionOutput } from "./opencodeRuntime.ts";
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
});
