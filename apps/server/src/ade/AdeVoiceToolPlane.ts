/**
 * The controller MCP surface's view of an ADE voice call (spec §4.7, S16).
 *
 * The voice controller reaches its tools over MCP, so retargeting §4.7 means
 * retargeting *that* catalog — a controller on an ADE call must see the five
 * ADE tools instead of `thread_list`/`thread_get`/`thread_create`/
 * `thread_send`/`thread_interrupt`, and its invocations must run under the
 * call's bot authority.
 *
 * This port is deliberately tiny and deliberately structural:
 *
 * - `catalogFor` returns **null** for every thread that is not an ADE call,
 *   and null means "behave exactly as before". Non-ADE voice threads never
 *   touch a line of ADE code; the classic toolkit is not conditional on
 *   anything ADE does.
 * - The join key is the controller thread id, because that is the only
 *   identity that actually rides an MCP invocation: the bearer credential
 *   resolves to a `VoiceControllerMcpProfile`, and its `controllerThreadId` is
 *   the thread the credential was minted for. No ADE field is added to the
 *   credential, so a credential cannot claim a bot it was not issued for.
 *
 * It lives in its own module so `ControllerMcpHttpServer` can depend on the
 * seam without pulling the ADE service graph into the MCP module graph; the
 * live binding to `AdeVoiceChannel` is in `AdeVoiceChannelPortsLive.ts`.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { ThreadId } from "@shuv2code/contracts";

/** Model-visible tool description: name, prose, raw JSON Schema. */
export interface AdeVoiceToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

/**
 * Every dispatch settles. A refusal is an ordinary failed tool result the
 * model can read, never a transport error — the same contract the ADE tool
 * gate already guarantees on the text side.
 */
export type AdeVoiceToolPlaneResult =
  | { readonly ok: true; readonly content: string }
  | { readonly ok: false; readonly message: string };

export interface AdeVoiceToolPlaneShape {
  /** The ADE catalog for this controller thread, or null if it is not an ADE call. */
  readonly catalogFor: (
    controllerThreadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<AdeVoiceToolDescriptor> | null>;
  /** Run one invocation under the call's bot authority. */
  readonly dispatch: (input: {
    readonly controllerThreadId: ThreadId;
    readonly tool: string;
    readonly input: unknown;
    readonly callId?: string;
  }) => Effect.Effect<AdeVoiceToolPlaneResult>;
}

export class AdeVoiceToolPlane extends Context.Service<AdeVoiceToolPlane, AdeVoiceToolPlaneShape>()(
  "shuv2code/ade/AdeVoiceToolPlane",
) {
  /**
   * No ADE calls exist in this build: every thread is a classic controller
   * thread. This is the default, and it is what keeps the swap invisible to
   * every non-ADE voice session.
   */
  static readonly layerAbsent: Layer.Layer<AdeVoiceToolPlane> = Layer.succeed(AdeVoiceToolPlane, {
    catalogFor: () => Effect.succeed(null),
    dispatch: (input) =>
      Effect.succeed({
        ok: false,
        message: `[ade:unknown-tool] Tool '${input.tool}' is not available to this session.`,
      }),
  });
}
