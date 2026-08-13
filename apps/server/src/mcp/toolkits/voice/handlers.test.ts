import { EnvironmentId, ProviderInstanceId, ThreadId } from "@shuv2code/contracts";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { describe, expect } from "vite-plus/test";

import { VoiceControllerService } from "../../../voice/Services/VoiceControllerService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { voiceHandlers } from "./handlers.ts";

const invocation = {
  credentialId: "credential-1",
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  profile: { kind: "standard-provider" as const },
  capabilities: new Set<McpInvocationContext.McpCapability>(["voice.speak"]),
  issuedAt: 1,
};

describe("voice MCP authority", () => {
  effectIt.effect("speaks only through the exact authenticated thread context", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<Array<unknown>>([]);
      const layer = Layer.mergeAll(
        Layer.succeed(McpInvocationContext.McpInvocationContext, invocation),
        Layer.mock(VoiceControllerService)({
          speakInThreadCall: (input) =>
            Ref.update(calls, (all) => [...all, input]).pipe(Effect.as(true)),
        }),
      );
      expect(
        yield* voiceHandlers
          .voice_speak({ text: "I found the failing boundary." })
          .pipe(Effect.provide(layer)),
      ).toEqual({ spoken: true });
      expect(yield* Ref.get(calls)).toEqual([
        {
          environmentId: invocation.environmentId,
          threadId: invocation.threadId,
          text: "I found the failing boundary.",
        },
      ]);
    }),
  );

  effectIt.effect("fails closed when no call is attached to the authenticated thread", () =>
    Effect.gen(function* () {
      const layer = Layer.mergeAll(
        Layer.succeed(McpInvocationContext.McpInvocationContext, invocation),
        Layer.mock(VoiceControllerService)({ speakInThreadCall: () => Effect.succeed(false) }),
      );
      expect(
        yield* voiceHandlers
          .voice_speak({ text: "This must not leak into another call." })
          .pipe(Effect.provide(layer), Effect.flip),
      ).toMatchObject({ reason: "call_not_active" });
    }),
  );
});
