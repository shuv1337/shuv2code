import { TurnId } from "@shuv2code/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveComposerTurnDispatch } from "./composerTurnDispatch";

describe("resolveComposerTurnDispatch", () => {
  it("steers a running server thread against its exact active turn", () => {
    expect(
      resolveComposerTurnDispatch({
        isServerThread: true,
        turnSteering: "same-turn",
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

  it("blocks running sessions without exact same-turn steering support", () => {
    expect(
      resolveComposerTurnDispatch({
        isServerThread: true,
        turnSteering: "same-turn",
        session: { status: "running", activeTurnId: null },
      }),
    ).toEqual({ _tag: "blocked", reason: "missing-active-turn" });

    for (const turnSteering of [undefined, "unsupported"] as const) {
      expect(
        resolveComposerTurnDispatch({
          isServerThread: true,
          ...(turnSteering === undefined ? {} : { turnSteering }),
          session: { status: "running", activeTurnId: TurnId.make("turn-1") },
        }),
      ).toEqual({ _tag: "blocked", reason: "turn-steering-unsupported" });
    }
  });

  it("blocks while thread state is synchronizing", () => {
    expect(
      resolveComposerTurnDispatch({
        isServerThread: true,
        isSynchronizing: true,
        turnSteering: "same-turn",
        session: { status: "running", activeTurnId: TurnId.make("turn-1") },
      }),
    ).toEqual({ _tag: "blocked", reason: "synchronizing" });
    expect(
      resolveComposerTurnDispatch({
        isServerThread: true,
        turnSteering: "same-turn",
        session: { status: "starting", activeTurnId: null },
      }),
    ).toEqual({ _tag: "blocked", reason: "synchronizing" });
  });
});
