import { TurnId } from "@shuv2code/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveComposerTurnDispatch } from "./composerTurnDispatch";

describe("resolveComposerTurnDispatch", () => {
  it("steers a running server thread against its exact active turn", () => {
    expect(
      resolveComposerTurnDispatch({
        isServerThread: true,
        session: { status: "running", activeTurnId: TurnId.make("turn-1") },
      }),
    ).toEqual({ _tag: "steer", expectedTurnId: "turn-1" });
  });

  it("starts an idle server thread or local draft", () => {
    expect(
      resolveComposerTurnDispatch({
        isServerThread: true,
        session: { status: "ready", activeTurnId: null },
      }),
    ).toEqual({ _tag: "start" });
    expect(resolveComposerTurnDispatch({ isServerThread: false, session: null })).toEqual({
      _tag: "start",
    });
  });

  it("blocks an inconsistent running session without an active turn id", () => {
    expect(
      resolveComposerTurnDispatch({
        isServerThread: true,
        session: { status: "running", activeTurnId: null },
      }),
    ).toEqual({ _tag: "blocked" });
  });
});
