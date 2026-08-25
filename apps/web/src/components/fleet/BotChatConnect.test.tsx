import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { BotChatConnectNoticeStrip, BotChatPendingConversation } from "./BotChatConnect";

/**
 * The states M8 (#217) put in place of the Start/Resume interstitial.
 *
 * These are rendering assertions rather than logic ones because the thing the
 * captain objected to *was* the rendering: a landing page where a conversation
 * should have been. The web suite has no DOM, so `renderToStaticMarkup` is the
 * available instrument; both components are pure props-in for exactly that
 * reason.
 */

const NOTICE = {
  message: "This bot isn't connected — check its provider settings.",
  details: "No 'opencode2' provider instance is configured. Add one in Settings → Providers.",
};

describe("BotChatConnectNoticeStrip", () => {
  it("leads with one product-voice sentence", () => {
    const markup = renderToStaticMarkup(
      <BotChatConnectNoticeStrip notice={NOTICE} onRetry={() => {}} />,
    );
    expect(markup).toContain("This bot isn&#x27;t connected");
    expect(markup).toContain("Retry");
  });

  it("keeps technical remediation inside a collapsed disclosure", () => {
    const markup = renderToStaticMarkup(
      <BotChatConnectNoticeStrip notice={NOTICE} onRetry={() => {}} />,
    );
    // A native <details> with no `open` attribute: present in the DOM, closed
    // on arrival. The provider-instance id must never be primary copy.
    expect(markup).toContain("<details");
    expect(markup).not.toContain("<details open");
    expect(markup).toContain("Details</summary>");
    const beforeDisclosure = markup.slice(0, markup.indexOf("<details"));
    expect(beforeDisclosure).not.toContain("opencode2");
    expect(markup).toContain("opencode2");
  });

  it("draws no disclosure when there is nothing technical to hide", () => {
    const markup = renderToStaticMarkup(
      <BotChatConnectNoticeStrip
        notice={{ message: "This conversation didn't finish loading.", details: null }}
        onRetry={() => {}}
      />,
    );
    expect(markup).not.toContain("<details");
  });

  it("offers no retry for an informational strip", () => {
    const markup = renderToStaticMarkup(
      <BotChatConnectNoticeStrip
        notice={{ message: "Delegation and memory are unavailable for this bot.", details: null }}
        tone="muted"
      />,
    );
    expect(markup).not.toContain("Retry");
    expect(markup).toContain('role="status"');
  });

  it("announces a failure as an alert", () => {
    expect(renderToStaticMarkup(<BotChatConnectNoticeStrip notice={NOTICE} />)).toContain(
      'role="alert"',
    );
  });
});

describe("BotChatPendingConversation", () => {
  it("renders a conversation shell, not a landing page", () => {
    const markup = renderToStaticMarkup(<BotChatPendingConversation botName="Firstmate" shimmer />);
    // The composer stand-in is present and inert: the shape of the surface is
    // the conversation from the first frame.
    expect(markup).toContain("Message Firstmate");
    expect(markup).toContain('aria-disabled="true"');
    // None of the interstitial's vocabulary may reappear here.
    for (const banned of [
      "Start chatting",
      "Resume chatting",
      "standing by",
      "already has a session",
      "shuvcode service start",
    ]) {
      expect(markup).not.toContain(banned);
    }
  });

  it("shimmers only while it is still connecting", () => {
    const connecting = renderToStaticMarkup(
      <BotChatPendingConversation botName="Firstmate" shimmer />,
    );
    const failed = renderToStaticMarkup(
      <BotChatPendingConversation botName="Firstmate" shimmer={false} />,
    );
    expect(connecting).toContain("animate-pulse");
    // A pulse that never resolves reads as "still trying" beside a notice that
    // says it stopped.
    expect(failed).not.toContain("animate-pulse");
    // The composer stand-in survives either way — the shell does not collapse.
    expect(failed).toContain("Message Firstmate");
  });
});
