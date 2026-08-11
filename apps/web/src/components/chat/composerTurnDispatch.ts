import type { ServerProviderTurnSteering, TurnId } from "@shuv2code/contracts";

export type ComposerTurnDispatch =
  | { readonly _tag: "start" }
  | { readonly _tag: "steer"; readonly expectedTurnId: TurnId }
  | {
      readonly _tag: "blocked";
      readonly reason: "synchronizing" | "missing-active-turn" | "turn-steering-unsupported";
    };

export function resolveComposerTurnDispatch(input: {
  readonly isServerThread: boolean;
  readonly isSynchronizing?: boolean;
  readonly turnSteering?: ServerProviderTurnSteering;
  readonly session:
    | {
        readonly status: string;
        readonly activeTurnId: TurnId | null;
      }
    | null
    | undefined;
}): ComposerTurnDispatch {
  if (!input.isServerThread) {
    return { _tag: "start" };
  }
  if (input.isSynchronizing) {
    return { _tag: "blocked", reason: "synchronizing" };
  }
  if (input.session?.status === "starting") {
    return { _tag: "blocked", reason: "synchronizing" };
  }
  if (input.session?.status !== "running") {
    return { _tag: "start" };
  }
  if (!input.session.activeTurnId) {
    return { _tag: "blocked", reason: "missing-active-turn" };
  }
  if (input.turnSteering !== "same-turn") {
    return { _tag: "blocked", reason: "turn-steering-unsupported" };
  }
  return { _tag: "steer", expectedTurnId: input.session.activeTurnId };
}
