import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { BotScreenViewer } from "./BotScreenViewer";

/**
 * Markup shape for the shared viewer.
 *
 * These exist because the rail's first cut made the thumbnail clickable by
 * wrapping the whole viewer in a `<button>`. That put `<div>`s and a
 * `role="alert"` inside a button: invalid HTML, and — worse than invalid — an
 * error announced to a screen reader as part of the button's *label* rather
 * than as an error. The `overlay` slot exists so the interactive layer can sit
 * inside the frame while the alert stays outside it.
 */
describe("BotScreenViewer", () => {
  it("renders the overlay inside the frame, not around the viewer", () => {
    const markup = renderToStaticMarkup(
      <BotScreenViewer
        overlay={<button type="button">Expand</button>}
        viewerPath="/ade/screen/bot-1"
      />,
    );
    const button = markup.indexOf("<button");
    const viewport = markup.indexOf('data-testid="ade-vnc-viewport"');
    expect(button).toBeGreaterThan(-1);
    expect(viewport).toBeGreaterThan(-1);
    // The canvas comes first and the overlay after it, both inside the frame.
    expect(viewport).toBeLessThan(button);
    // Nothing but phrasing content from the button onwards: no `<div>` and no
    // `role="alert"` nested inside it, which is the whole defect.
    expect(markup.slice(button)).not.toContain("<div");
    expect(markup.slice(button)).not.toContain('role="alert"');
  });

  it("leaves the Screen tab's frame exactly as it was", () => {
    // The tab passes no `frameClassName`. Inheriting the rail's `min-h-0
    // flex-1` here would have quietly changed a layout nobody asked to change.
    const markup = renderToStaticMarkup(<BotScreenViewer viewerPath="/ade/screen/bot-1" />);
    expect(markup).not.toContain("min-h-0");
    expect(markup).not.toContain("flex-1");
    expect(markup).toContain("h-[28rem]");
  });

  it("sizes the frame when a caller asks it to flex", () => {
    const markup = renderToStaticMarkup(
      <BotScreenViewer frameClassName="min-h-0 flex-1" viewerPath="/ade/screen/bot-1" />,
    );
    expect(markup).toContain("min-h-0");
  });
});
