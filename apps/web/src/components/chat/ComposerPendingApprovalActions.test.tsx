import { ApprovalRequestId } from "@shuv2code/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";

describe("ComposerPendingApprovalActions", () => {
  it("offers one explicit durable-grant action for thread control", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalActions
        requestId={ApprovalRequestId.make("thread-control-grant:approval-1")}
        requestKind="thread-control"
        isResponding={false}
        onRespondToApproval={vi.fn()}
      />,
    );

    expect(markup).toContain("Grant thread control");
    expect(markup).toContain("Deny");
    expect(markup).not.toContain("Approve once");
    expect(markup).not.toContain("Always allow this session");
  });
});
