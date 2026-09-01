import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { ExpandedImageDialog } from "./ExpandedImageDialog";

describe("ExpandedImageDialog", () => {
  it("uses the zoomable image viewport while retaining navigation and image context", () => {
    const markup = renderToStaticMarkup(
      <ExpandedImageDialog
        preview={{
          images: [
            { src: "data:image/webp;base64,first", name: "first.webp" },
            { src: "data:image/png;base64,second", name: "second.png" },
          ],
          index: 0,
        }}
        onClose={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="Expanded image preview"');
    expect(markup).toContain('data-slot="dialog-popup"');
    expect(markup).toContain('aria-label="first.webp image viewer"');
    expect(markup).toContain('aria-label="Previous image"');
    expect(markup).toContain('aria-label="Next image"');
    expect(markup).toContain("first.webp (1/2)");
  });
});
