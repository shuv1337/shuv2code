import { ApprovalRequestId } from "@shuv2code/contracts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadControlGrantRepository } from "../../../persistence/Services/ThreadControlGrants.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export class ThreadControlGrantRequestError extends Schema.TaggedErrorClass<ThreadControlGrantRequestError>()(
  "ThreadControlGrantRequestError",
  {
    reason: Schema.Literals(["unauthorized", "thread_not_found", "persistence_failed"]),
    message: Schema.String,
  },
) {}

export const ThreadControlGrantRequestResult = Schema.Struct({
  status: Schema.Literals(["pending_approval", "already_pending", "already_granted"]),
  requestId: Schema.NullOr(ApprovalRequestId),
  activation: Schema.Literal("next_turn"),
  message: Schema.String,
});

export const ThreadControlGrantRequestTool = Tool.make("thread_control_request", {
  description:
    "Request the user's durable permission for this thread to control other shuv2code threads. This does not self-grant access: it opens a visible host approval that only the user can accept. If approved, the shuv2code_controller tools attach on the next turn.",
  success: ThreadControlGrantRequestResult,
  failure: ThreadControlGrantRequestError,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    OrchestrationEngineService,
    ProjectionSnapshotQuery,
    ThreadControlGrantRepository,
    Crypto.Crypto,
  ],
})
  .annotate(Tool.Title, "Request durable thread control")
  // The provider must be able to ask without first passing through its own
  // provider-specific MCP approval gate. This operation cannot grant or use
  // thread control; its only effect is opening the host-owned user approval.
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadControlGrantRequestToolkit = Toolkit.make(ThreadControlGrantRequestTool);
