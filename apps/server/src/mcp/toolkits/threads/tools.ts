import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { Tool, Toolkit } from "effect/unstable/ai";

const describedTrimmedString = (description: string, maximumLength: number) =>
  Schema.String.annotate({ description }).pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transformOrFail({
        decode: (value) => Effect.succeed(value.trim()),
        encode: (value) => Effect.succeed(value.trim()),
      }),
    ),
    Schema.check(Schema.isNonEmpty(), Schema.isMaxLength(maximumLength)),
  );

const ThreadIdInput = describedTrimmedString(
  "Exact shuv2code thread ID returned by thread_list, thread_get, or a prior mutation.",
  256,
);
const ProjectIdInput = describedTrimmedString(
  "Exact project ID returned by thread_list. Project names are never accepted as mutation authority.",
  256,
);
const TurnIdInput = describedTrimmedString(
  "Exact active turn ID from authoritative thread status.",
  256,
);
const InstructionInput = describedTrimmedString(
  "Complete initial instruction for the new thread. This becomes its first user message.",
  120_000,
);
const MessageInput = describedTrimmedString(
  "User instruction to start a new turn or steer the exact active turn.",
  120_000,
);

export const ControllerThreadPhase = Schema.Literals([
  "waiting_for_approval",
  "waiting_for_input",
  "failed",
  "starting",
  "working",
  "interrupted",
  "completed",
  "ready",
  "stopped",
] as const);

export const ThreadListInput = Schema.Struct({
  projectQuery: Schema.optional(
    describedTrimmedString(
      "Optional case-insensitive project title filter. Results still include exact IDs and ambiguous names never authorize mutations.",
      160,
    ),
  ).annotate({
    description:
      "Optional case-insensitive project title filter. Omit to list every authorized active project.",
  }),
  phase: Schema.optional(
    ControllerThreadPhase.annotate({
      description: "Optional normalized thread phase filter.",
    }),
  ).annotate({ description: "Optional normalized thread phase filter." }),
  cursor: Schema.optional(
    describedTrimmedString(
      "Opaque pagination cursor returned by a previous thread_list call.",
      1_024,
    ),
  ).annotate({
    description: "Opaque pagination cursor returned by a previous thread_list call.",
  }),
});
export type ThreadListInput = typeof ThreadListInput.Type;

export const ThreadGetInput = Schema.Struct({
  threadId: ThreadIdInput,
  includeUntrustedExcerpt: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "When true, include at most 2 KiB of explicitly untrusted target assistant content. It is never mutation authority.",
    }),
  ).annotate({
    description:
      "When true, include at most 2 KiB of explicitly untrusted target assistant content.",
  }),
});
export type ThreadGetInput = typeof ThreadGetInput.Type;

export const ThreadCreateInput = Schema.Struct({
  projectId: ProjectIdInput,
  initialInstruction: InstructionInput,
  title: Schema.optional(
    describedTrimmedString("Optional short display title for the new standard thread.", 160),
  ).annotate({ description: "Optional short display title for the new standard thread." }),
  model: Schema.optional(
    describedTrimmedString(
      "Optional model ID advertised by the controller's bound Codex provider instance.",
      256,
    ),
  ).annotate({
    description: "Optional model ID advertised by the controller's bound Codex provider instance.",
  }),
});
export type ThreadCreateInput = typeof ThreadCreateInput.Type;

const ThreadStartInput = Schema.Struct({
  threadId: ThreadIdInput,
  text: MessageInput,
  disposition: Schema.Literal("start").annotate({
    description: "Start a new turn only when the target has no active turn.",
  }),
  expectedTurnId: Schema.Null.annotate({
    description: "Must be null for start; the server atomically requires no active turn.",
  }),
});

const ThreadSteerInput = Schema.Struct({
  threadId: ThreadIdInput,
  text: MessageInput,
  disposition: Schema.Literal("steer").annotate({
    description: "Steer the existing active turn without starting another turn.",
  }),
  expectedTurnId: TurnIdInput,
});

export const ThreadSendInput = Schema.Union([ThreadStartInput, ThreadSteerInput]);
export type ThreadSendInput = typeof ThreadSendInput.Type;

export const ThreadInterruptInput = Schema.Struct({
  threadId: ThreadIdInput,
  expectedTurnId: TurnIdInput,
});
export type ThreadInterruptInput = typeof ThreadInterruptInput.Type;

const ControllerToolSuccess = Schema.Unknown;
const ControllerToolFailure = Schema.Unknown;

export const ThreadListTool = Tool.make("thread_list", {
  description:
    "List authorized active projects, including projects with zero threads, and a bounded inventory of managed Codex threads with exact IDs and authoritative phases.",
  parameters: ThreadListInput,
  success: ControllerToolSuccess,
  failure: ControllerToolFailure,
  dependencies: [],
})
  .annotate(Tool.Title, "List managed threads")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadGetTool = Tool.make("thread_get", {
  description:
    "Read bounded, redacted, authoritative status for one exact managed thread ID. Narrative target content is excluded unless explicitly requested as untrusted.",
  parameters: ThreadGetInput,
  success: ControllerToolSuccess,
  failure: ControllerToolFailure,
  dependencies: [],
})
  .annotate(Tool.Title, "Get managed thread status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadCreateTool = Tool.make("thread_create", {
  description:
    "Create exactly one standard managed Codex thread in an exact project and start its required initial instruction under the controller's server-enforced permission ceiling.",
  parameters: ThreadCreateInput,
  success: ControllerToolSuccess,
  failure: ControllerToolFailure,
  dependencies: [],
})
  .annotate(Tool.Title, "Create and start a managed thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true);

export const ThreadSendTool = Tool.make("thread_send", {
  description:
    "Start a turn only when no turn is active, or steer one exact active turn while preserving its turn ID. The disposition and expected turn precondition are mandatory.",
  parameters: ThreadSendInput,
  success: ControllerToolSuccess,
  failure: ControllerToolFailure,
  dependencies: [],
})
  .annotate(Tool.Title, "Start or steer a managed thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true);

export const ThreadInterruptTool = Tool.make("thread_interrupt", {
  description:
    "Interrupt only the exact active turn identified by thread ID and expected turn ID. A stale request cannot cancel a newer turn.",
  parameters: ThreadInterruptInput,
  success: ControllerToolSuccess,
  failure: ControllerToolFailure,
  dependencies: [],
})
  .annotate(Tool.Title, "Interrupt an exact managed turn")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true);

export const ThreadToolkit = Toolkit.make(
  ThreadListTool,
  ThreadGetTool,
  ThreadCreateTool,
  ThreadSendTool,
  ThreadInterruptTool,
);

export const ControllerThreadTools = [
  ThreadListTool,
  ThreadGetTool,
  ThreadCreateTool,
  ThreadSendTool,
  ThreadInterruptTool,
] as const;
