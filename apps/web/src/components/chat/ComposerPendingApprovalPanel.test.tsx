import { ApprovalRequestId } from "@shuv2code/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";

describe("ComposerPendingApprovalPanel", () => {
  it("renders complete multiline command details without hover or truncation", () => {
    const detail = `bun run release -- ${"x".repeat(500)}\nsecond line`;
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: ApprovalRequestId.make("approval-1"),
          requestKind: "command",
          createdAt: "2026-07-18T00:00:00.000Z",
          detail,
        }}
        pendingCount={1}
      />,
    );

    expect(markup).toContain('data-approval-detail="complete"');
    expect(markup).toContain('aria-label="Command"');
    expect(markup).toContain(detail);
    expect(markup).not.toContain("truncate");
    expect(markup).not.toContain("line-clamp");
    expect(markup).toContain("min-w-0");
    expect(markup).toContain("max-w-full");
    expect(markup).toContain("[overflow-wrap:anywhere]");
  });

  it("labels a durable thread-control grant distinctly from a command", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: ApprovalRequestId.make("thread-control-grant:approval-1"),
          requestKind: "thread-control",
          createdAt: "2026-08-22T00:00:00.000Z",
          detail: "Allow this thread to control other threads.",
        }}
        pendingCount={1}
      />,
    );

    expect(markup).toContain("Durable thread-control access requested");
    expect(markup).toContain('aria-label="Access requested"');
    expect(markup).not.toContain("Command approval requested");
  });
});
