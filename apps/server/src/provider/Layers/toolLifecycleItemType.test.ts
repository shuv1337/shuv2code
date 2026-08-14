import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import { toToolLifecycleItemType } from "./toolLifecycleItemType.ts";

describe("toToolLifecycleItemType", () => {
  it("classifies the shared OpenCode tool families", () => {
    NodeAssert.equal(toToolLifecycleItemType("shell"), "command_execution");
    NodeAssert.equal(toToolLifecycleItemType("bash_command"), "command_execution");
    NodeAssert.equal(toToolLifecycleItemType("multiEdit"), "file_change");
    NodeAssert.equal(toToolLifecycleItemType("webfetch"), "web_search");
    NodeAssert.equal(toToolLifecycleItemType("github_mcp"), "mcp_tool_call");
    NodeAssert.equal(toToolLifecycleItemType("view_image"), "image_view");
    NodeAssert.equal(toToolLifecycleItemType("spawn_subtask"), "collab_agent_tool_call");
    NodeAssert.equal(toToolLifecycleItemType("custom_tool"), "dynamic_tool_call");
  });
});
