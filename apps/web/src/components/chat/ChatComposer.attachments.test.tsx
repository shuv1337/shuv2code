import { describe, expect, it } from "vite-plus/test";

import chatComposerSource from "./ChatComposer.tsx?raw";

describe("ChatComposer attachment picker", () => {
  it("exposes a tap-driven image and PDF file input", () => {
    expect(chatComposerSource).toContain('aria-label="Attach images or PDFs"');
    expect(chatComposerSource).toContain(
      'accept="image/gif,image/jpeg,image/png,image/webp,application/pdf,.pdf"',
    );
    expect(chatComposerSource).toContain(
      "isImage && !isProviderSendTurnSupportedImageMimeType(file.type)",
    );
    expect(chatComposerSource).toContain("void addComposerImages(files)");
    expect(chatComposerSource).toContain('event.currentTarget.value = ""');
  });
});
