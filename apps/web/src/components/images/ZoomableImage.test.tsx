import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { ZoomableImage } from "./ZoomableImage";

describe("ZoomableImage", () => {
  it("renders an accessible image viewport and discoverable controls", () => {
    const markup = renderToStaticMarkup(
      <ZoomableImage src="data:image/webp;base64,example" alt="preview.webp" onError={vi.fn()} />,
    );

    expect(markup).toContain('aria-label="preview.webp image viewer"');
    expect(markup).toContain('data-keybinding-capture=""');
    expect(markup).toContain('aria-label="Image zoom controls"');
    expect(markup).toContain('aria-label="Zoom out image"');
    expect(markup).toContain('aria-label="Zoom in image"');
    expect(markup).toContain('aria-label="Fit image to view"');
    expect(markup).toContain('aria-label="Show image at actual size"');
    expect(markup).toContain('src="data:image/webp;base64,example"');
    expect(markup).toContain('alt="preview.webp"');
  });
});
