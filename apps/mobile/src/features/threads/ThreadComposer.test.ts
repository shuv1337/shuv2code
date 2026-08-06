import { describe, expect, it } from "vite-plus/test";

import { collapsedComposerActions } from "./threadComposerActions";

describe("collapsedComposerActions", () => {
  it("shows both Stop and Send while a running thread has draft content", () => {
    expect(collapsedComposerActions({ hasContent: true, isRunning: true })).toEqual({
      showSend: true,
      showStop: true,
    });
  });

  it("shows only Stop while a running thread has no draft content", () => {
    expect(collapsedComposerActions({ hasContent: false, isRunning: true })).toEqual({
      showSend: false,
      showStop: true,
    });
  });

  it("shows Send while the thread is idle", () => {
    expect(collapsedComposerActions({ hasContent: false, isRunning: false })).toEqual({
      showSend: true,
      showStop: false,
    });
  });
});
