import type { TurnId } from "@shuv2code/contracts";

export type ComposerTurnDispatch =
  | { readonly _tag: "start" }
  | { readonly _tag: "steer"; readonly expectedTurnId: TurnId }
  | { readonly _tag: "blocked" };

export function resolveComposerTurnDispatch(input: {
  readonly isServerThread: boolean;
  readonly session:
    | {
        readonly status: string;
        readonly activeTurnId: TurnId | null;
      }
    | null
    | undefined;
}): ComposerTurnDispatch {
  if (!input.isServerThread || input.session?.status !== "running") {
    return { _tag: "start" };
  }
  return input.session.activeTurnId
    ? { _tag: "steer", expectedTurnId: input.session.activeTurnId }
    : { _tag: "blocked" };
}
