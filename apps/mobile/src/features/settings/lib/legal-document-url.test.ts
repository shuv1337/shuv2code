import { describe, expect, it } from "vite-plus/test";

import { isLegalDocumentUrl } from "./legal-document-url";

describe("isLegalDocumentUrl", () => {
  it.each([
    "https://shuv2code.example/legal",
    "https://shuv2code.example/legal/",
    "https://shuv2code.example/privacy-policy?source=app",
    "https://shuv2code.example/terms-of-service#updates",
    "https://shuv2code.example/security-policy",
  ])("allows a configured legal document: %s", (url) => {
    expect(isLegalDocumentUrl(url)).toBe(true);
  });

  it.each([
    "https://shuv2code.example/download",
    "https://example.com/legal",
    "javascript:alert(1)",
    "not-a-url",
  ])("rejects a URL outside the legal-document allowlist: %s", (url) => {
    expect(isLegalDocumentUrl(url)).toBe(false);
  });
});
