import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

const EMPTY_ASYNC_RESULT_ATOM = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel("web-environment-query:empty"),
);

export interface EnvironmentQueryView<A> {
  readonly data: A | null;
  readonly error: string | null;
  /**
   * The squashed failure itself, not its message. `error` flattens a tagged
   * error to prose, which is fine for display and useless for branching — a
   * surface that has to tell "this project is gone" from "the socket dropped"
   * needs the tag (see `adeCaptainErrorReason`).
   */
  readonly failure: unknown;
  readonly isPending: boolean;
  readonly refresh: () => void;
}

export function formatEnvironmentQueryError(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The environment request failed.";
}

export function useEnvironmentQuery<A, E>(
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>> | null,
): EnvironmentQueryView<A> {
  const selectedAtom = atom ?? EMPTY_ASYNC_RESULT_ATOM;
  const result = useAtomValue(selectedAtom);
  const refresh = useAtomRefresh(selectedAtom);
  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
    failure: result._tag === "Failure" ? Cause.squash(result.cause) : null,
    isPending: atom !== null && result.waiting,
    refresh,
  };
}
