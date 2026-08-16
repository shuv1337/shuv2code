import { IsoDateTime, RuntimeMode, ThreadId } from "@shuv2code/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const DurableThreadControlGrant = Schema.Struct({
  threadId: ThreadId,
  authorizedRuntimeCeiling: RuntimeMode,
  controlEnabled: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type DurableThreadControlGrant = typeof DurableThreadControlGrant.Type;

export interface ThreadControlGrantRepositoryShape {
  readonly getByThreadId: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<DurableThreadControlGrant>, ProjectionRepositoryError>;
  readonly upsert: (
    grant: DurableThreadControlGrant,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly revoke: (threadId: ThreadId) => Effect.Effect<boolean, ProjectionRepositoryError>;
}

export class ThreadControlGrantRepository extends Context.Service<
  ThreadControlGrantRepository,
  ThreadControlGrantRepositoryShape
>()("shuv2code/persistence/Services/ThreadControlGrants/ThreadControlGrantRepository") {}
