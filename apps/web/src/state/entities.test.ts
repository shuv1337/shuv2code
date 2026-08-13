import { scopeThreadRef } from "@shuv2code/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@shuv2code/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isUserFacingThreadShell, resolveThreadDetailRef } from "./entities";

const threadRef = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-1"));

describe("resolveThreadDetailRef", () => {
  it("does not subscribe to a reserved draft thread before it enters the shell index", () => {
    expect(
      resolveThreadDetailRef(threadRef, {
        shellExists: false,
        waitForShell: true,
      }),
    ).toBeNull();
  });

  it("subscribes once the reserved draft thread enters the shell index", () => {
    expect(
      resolveThreadDetailRef(threadRef, {
        shellExists: true,
        waitForShell: true,
      }),
    ).toBe(threadRef);
  });

  it("keeps direct server-thread lookups enabled when the shell has not loaded it", () => {
    expect(
      resolveThreadDetailRef(threadRef, {
        shellExists: false,
        waitForShell: false,
      }),
    ).toBe(threadRef);
  });
});

describe("isUserFacingThreadShell", () => {
  it("keeps ordinary threads in user thread surfaces", () => {
    expect(isUserFacingThreadShell({ purpose: undefined })).toBe(true);
    expect(isUserFacingThreadShell({ purpose: "standard" })).toBe(true);
  });

  it("hides managed voice runtime threads from user thread surfaces", () => {
    expect(isUserFacingThreadShell({ purpose: "voice-controller" })).toBe(false);
    expect(isUserFacingThreadShell({ purpose: "voice-transport" })).toBe(false);
  });
});
