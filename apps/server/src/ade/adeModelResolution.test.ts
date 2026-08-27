/**
 * The resolution ladder. Every case here is a shape that was observed on a
 * live VM: a free model that answers tool calls in pseudo-XML, an *image*
 * model that made every turn fail with nothing to read, and a hand-edited
 * project default naming a model that cannot call tools.
 */
import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import { ProviderInstanceId, type ServerProviderModel } from "@shuv2code/contracts";
import { createModelCapabilities } from "@shuv2code/shared/model";

import { ADE_SHUVCODE_INSTANCE_ID, resolveAdeModelSelection } from "./AdeShuvcodeChatSession.ts";

const model = (
  slug: string,
  capabilities?: { toolCalling?: boolean; textOutput?: boolean; isDefault?: boolean },
): ServerProviderModel => ({
  slug,
  name: slug,
  isCustom: false,
  ...(capabilities?.isDefault === true ? { isDefault: true } : {}),
  capabilities: createModelCapabilities({
    optionDescriptors: [],
    ...(capabilities?.toolCalling === undefined ? {} : { toolCalling: capabilities.toolCalling }),
    ...(capabilities?.textOutput === undefined ? {} : { textOutput: capabilities.textOutput }),
  }),
});

/** The catalog as observed: the free liar first, an image model second. */
const CATALOG: ReadonlyArray<ServerProviderModel> = [
  model("opencode/big-pickle", { toolCalling: false, textOutput: true }),
  model("openai/chatgpt-image-latest", { toolCalling: true, textOutput: false }),
  model("openai/gpt-5.6-sol", { toolCalling: true, textOutput: true, isDefault: true }),
  model("anthropic/claude-4.7", { toolCalling: true, textOutput: true }),
];

const shuvcode = (slug: string) => ({ instanceId: ADE_SHUVCODE_INSTANCE_ID, model: slug });

describe("resolveAdeModelSelection", () => {
  it("takes the bot's pin first, over both defaults", () => {
    const resolved = resolveAdeModelSelection({
      pinned: shuvcode("anthropic/claude-4.7"),
      projectDefault: shuvcode("openai/gpt-5.6-sol"),
      models: CATALOG,
    });
    NodeAssert.deepEqual(resolved, {
      kind: "resolved",
      slug: "anthropic/claude-4.7",
      source: "pinned",
      agentCapable: true,
    });
  });

  it("honours a pin the capability data disagrees with, and flags it", () => {
    // Deliberate choices are never refused: the data is provider-reported and
    // can be stale, and there is no override anywhere else in the product.
    const resolved = resolveAdeModelSelection({
      pinned: shuvcode("opencode/big-pickle"),
      projectDefault: null,
      models: CATALOG,
    });
    NodeAssert.deepEqual(resolved, {
      kind: "resolved",
      slug: "opencode/big-pickle",
      source: "pinned",
      agentCapable: false,
    });
  });

  it("keeps a pin the catalog no longer offers, but flags it", () => {
    // The captain's choice still wins the rung — there is no override anywhere
    // else — but a model the kernel has dropped fails every turn, so it must
    // not come back reported as healthy. That silence is the whole bug.
    const resolved = resolveAdeModelSelection({
      pinned: shuvcode("local/homegrown"),
      projectDefault: null,
      models: CATALOG,
    });
    NodeAssert.deepEqual(resolved, {
      kind: "resolved",
      slug: "local/homegrown",
      source: "pinned",
      agentCapable: false,
    });
  });

  it("does not judge a pin against an empty catalog", () => {
    // Nothing to compare against is not evidence of anything. The caller
    // refuses on an empty catalog before this ever runs; this only guarantees
    // the pure function never invents a verdict from silence.
    const resolved = resolveAdeModelSelection({
      pinned: shuvcode("openai/gpt-5.6-sol"),
      projectDefault: null,
      models: [],
    });
    NodeAssert.equal(resolved.kind === "resolved" && resolved.agentCapable, true);
  });

  it("ignores a pin that points at another provider", () => {
    // A Codex selection must never leak into a shuvcode session (spec §1).
    const resolved = resolveAdeModelSelection({
      pinned: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
      projectDefault: shuvcode("anthropic/claude-4.7"),
      models: CATALOG,
    });
    NodeAssert.equal(resolved.kind === "resolved" && resolved.source, "project-default");
  });

  it("falls to the project default when nothing is pinned", () => {
    const resolved = resolveAdeModelSelection({
      pinned: null,
      projectDefault: shuvcode("anthropic/claude-4.7"),
      models: CATALOG,
    });
    NodeAssert.deepEqual(resolved, {
      kind: "resolved",
      slug: "anthropic/claude-4.7",
      source: "project-default",
      agentCapable: true,
    });
  });

  it("skips a project default that cannot call tools rather than failing", () => {
    // This is the hand-edited `default_model_selection_json` row verbatim: it
    // is a default, not a decision, so it loses to the kernel's own default.
    const resolved = resolveAdeModelSelection({
      pinned: null,
      projectDefault: shuvcode("opencode/big-pickle"),
      models: CATALOG,
    });
    NodeAssert.equal(resolved.kind === "resolved" && resolved.source, "kernel-default");
  });

  it("skips a project default the catalog no longer offers", () => {
    const resolved = resolveAdeModelSelection({
      pinned: null,
      projectDefault: shuvcode("openai/retired"),
      models: CATALOG,
    });
    NodeAssert.equal(resolved.kind === "resolved" && resolved.source, "kernel-default");
  });

  it("takes the kernel's configured default before the catalog order", () => {
    const resolved = resolveAdeModelSelection({
      pinned: null,
      projectDefault: null,
      models: CATALOG,
    });
    NodeAssert.deepEqual(resolved, {
      kind: "resolved",
      slug: "openai/gpt-5.6-sol",
      source: "kernel-default",
      agentCapable: true,
    });
  });

  it("skips a kernel default that is itself incapable", () => {
    // `/api/model/default` answers with the newest model when the operator
    // configured nothing, which is how an image model became a bot's brain.
    const resolved = resolveAdeModelSelection({
      pinned: null,
      projectDefault: null,
      models: [
        model("openai/chatgpt-image-latest", {
          toolCalling: true,
          textOutput: false,
          isDefault: true,
        }),
        model("anthropic/claude-4.7", { toolCalling: true, textOutput: true }),
      ],
    });
    NodeAssert.deepEqual(resolved, {
      kind: "resolved",
      slug: "anthropic/claude-4.7",
      source: "first-capable",
      agentCapable: true,
    });
  });

  it("falls back to the first *capable* model, never to models[0]", () => {
    const resolved = resolveAdeModelSelection({
      pinned: null,
      projectDefault: null,
      models: [
        model("opencode/big-pickle", { toolCalling: false, textOutput: true }),
        model("openai/chatgpt-image-latest", { toolCalling: true, textOutput: false }),
        model("openai/gpt-5.6-sol", { toolCalling: true, textOutput: true }),
      ],
    });
    NodeAssert.deepEqual(resolved, {
      kind: "resolved",
      slug: "openai/gpt-5.6-sol",
      source: "first-capable",
      agentCapable: true,
    });
  });

  it("keeps models that never reported capabilities selectable", () => {
    // Absence is not a denial. Reading silence as "incapable" would make every
    // Codex, Cursor and hand-typed custom model unusable.
    const resolved = resolveAdeModelSelection({
      pinned: null,
      projectDefault: null,
      models: [
        { slug: "custom/local", name: "custom/local", isCustom: true, capabilities: null },
        model("openai/gpt-5.6-sol", { toolCalling: true, textOutput: true }),
      ],
    });
    NodeAssert.equal(resolved.kind === "resolved" && resolved.slug, "custom/local");
  });

  it("names the failure when no model in a non-empty catalog can run a bot", () => {
    const resolved = resolveAdeModelSelection({
      pinned: null,
      projectDefault: null,
      models: [
        model("opencode/big-pickle", { toolCalling: false, textOutput: true }),
        model("openai/chatgpt-image-latest", { toolCalling: true, textOutput: false }),
      ],
    });
    NodeAssert.deepEqual(resolved, { kind: "none-capable" });
  });

  it("reports none-capable on an empty catalog rather than inventing a model", () => {
    NodeAssert.deepEqual(
      resolveAdeModelSelection({ pinned: null, projectDefault: null, models: [] }),
      { kind: "none-capable" },
    );
  });
});
