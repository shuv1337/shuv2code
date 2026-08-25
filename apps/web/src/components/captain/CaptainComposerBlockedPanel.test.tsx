import { ApprovalRequestId, type ProviderApprovalDecision } from "@shuv2code/contracts";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { PendingApproval, PendingUserInput } from "../../session-logic";
import { CaptainComposerBlockedPanel } from "./CaptainComposerBlockedPanel";
import { resolveCaptainComposerBlockedState } from "./captainComposer.logic";

const AT = "2026-03-17T19:12:28.000Z";

function approval(requestKind: PendingApproval["requestKind"] = "command"): PendingApproval {
  return {
    requestId: ApprovalRequestId.make("approval-1"),
    requestKind,
    createdAt: AT,
    detail: "pnpm test",
  };
}

const NO_PENDING_USER_INPUTS: Array<PendingUserInput> = [];

function panel(input: {
  readonly approval: PendingApproval;
  readonly onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}) {
  return (
    <CaptainComposerBlockedPanel
      answers={{}}
      blocked={resolveCaptainComposerBlockedState({
        pendingApprovals: [input.approval],
        pendingUserInputs: NO_PENDING_USER_INPUTS,
      })}
      onAdvance={() => {}}
      onRespondToApproval={input.onRespondToApproval}
      onToggleOption={() => {}}
      pendingUserInputs={NO_PENDING_USER_INPUTS}
      questionIndex={0}
      respondingRequestIds={[]}
    />
  );
}

function resolveRenderFunction(type: unknown): ((props: unknown) => ReactNode) | null {
  if (typeof type === "function") return type as (props: unknown) => ReactNode;
  // `memo(fn)` keeps the component on `.type`.
  if (typeof type === "object" && type !== null && "type" in type) {
    const inner = (type as { type: unknown }).type;
    if (typeof inner === "function") return inner as (props: unknown) => ReactNode;
  }
  return null;
}

/**
 * Walks a rendered element tree and presses the first control whose visible
 * label matches.
 *
 * The suite runs in a `node` environment with no DOM, so a click cannot be
 * dispatched — but the handler is right there on the element, and invoking it
 * is the same call the browser would make. That is enough to prove the
 * *decision* reaches the caller, which is the thing that was missing.
 */
function pressControl(node: ReactNode, label: string): boolean {
  if (Array.isArray(node)) {
    return node.some((child) => pressControl(child as ReactNode, label));
  }
  if (!isValidElement(node)) return false;
  const props = (node as ReactElement<Record<string, unknown>>).props;
  if (props.children === label && typeof props.onClick === "function") {
    (props.onClick as () => void)();
    return true;
  }
  const render = resolveRenderFunction(node.type);
  if (render !== null) {
    try {
      if (pressControl(render(props), label)) return true;
    } catch {
      // A component that needs a DOM or a hook dispatcher is not on the path to
      // the control being pressed; keep walking siblings.
    }
  }
  return pressControl(props.children as ReactNode, label);
}

describe("CaptainComposerBlockedPanel", () => {
  it("offers the decision, not just a description of it", () => {
    const markup = renderToStaticMarkup(
      panel({ approval: approval(), onRespondToApproval: async () => undefined }),
    );

    expect(markup).toContain("PENDING APPROVAL");
    // The defect: the messenger mounted the panel above *without* these, so a
    // blocked conversation could not be unblocked from the messenger.
    expect(markup).toContain("Approve once");
    expect(markup).toContain("Decline");
    expect(markup).toContain("Always allow this session");
    expect(markup).toContain("Cancel turn");
  });

  it("renders the durable-grant wording for a thread-control request", () => {
    const markup = renderToStaticMarkup(
      panel({
        approval: approval("thread-control"),
        onRespondToApproval: async () => undefined,
      }),
    );

    expect(markup).toContain("Grant thread control");
    expect(markup).toContain("Deny");
    expect(markup).not.toContain("Approve once");
  });

  it("dispatches the captain's decision to the responder", () => {
    const decisions: Array<[ApprovalRequestId, ProviderApprovalDecision]> = [];
    const element = panel({
      approval: approval(),
      onRespondToApproval: async (requestId, decision) => {
        decisions.push([requestId, decision]);
      },
    });

    expect(pressControl(element, "Approve once")).toBe(true);
    expect(decisions).toEqual([[ApprovalRequestId.make("approval-1"), "accept"]]);

    expect(pressControl(element, "Decline")).toBe(true);
    expect(decisions[1]).toEqual([ApprovalRequestId.make("approval-1"), "decline"]);
  });
});
