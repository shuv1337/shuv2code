import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@shuv2code/contracts";

const files = new Map<string, { base64: string; deleted: boolean }>();
const launchImageLibraryAsync = vi.hoisted(() => vi.fn());

vi.mock("expo-image-picker", () => ({
  launchImageLibraryAsync,
  UIImagePickerPreferredAssetRepresentationMode: {
    Compatible: "compatible",
  },
}));

vi.mock("expo-file-system", () => ({
  File: class {
    readonly uri: string;

    constructor(uri: string) {
      this.uri = uri;
    }

    get exists(): boolean {
      return files.has(this.uri) && files.get(this.uri)?.deleted === false;
    }

    async base64(): Promise<string> {
      const entry = files.get(this.uri);
      if (!entry || entry.deleted) {
        throw new Error("missing file");
      }
      return entry.base64;
    }

    delete(): void {
      const entry = files.get(this.uri);
      if (entry) {
        entry.deleted = true;
      }
    }
  },
}));

vi.mock("./uuid", () => ({
  uuidv4: () => "attachment-id",
}));

import {
  convertPastedImagesToAttachments,
  isOwnedPastedImageUri,
  pickComposerImages,
  toUploadChatImageAttachments,
} from "./composerImages";

describe("pickComposerImages", () => {
  beforeEach(() => {
    launchImageLibraryAsync.mockReset();
  });

  it("accepts an iPhone HEIC asset when Expo returns JPEG base64", async () => {
    launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [
        {
          uri: "file:///photos/IMG_0001.HEIC",
          fileName: "IMG_0001.HEIC",
          mimeType: "image/heic",
          fileSize: 20,
          base64: "/9j/2Q==",
        },
      ],
    });

    const result = await pickComposerImages({ existingCount: 0 });

    expect(launchImageLibraryAsync).toHaveBeenCalledWith(
      expect.objectContaining({ preferredAssetRepresentationMode: "compatible" }),
    );
    expect(result).toEqual({
      images: [
        expect.objectContaining({
          mimeType: "image/jpeg",
          sizeBytes: 4,
          dataUrl: "data:image/jpeg;base64,/9j/2Q==",
        }),
      ],
      error: null,
    });
  });

  it("still rejects unsupported image bytes", async () => {
    launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [
        {
          uri: "file:///photos/IMG_0001.HEIC",
          fileName: "IMG_0001.HEIC",
          mimeType: "image/heic",
          base64: "AAAAHGZ0eXBoZWlj",
        },
      ],
    });

    const result = await pickComposerImages({ existingCount: 0 });

    expect(result.images).toEqual([]);
    expect(result.error).toContain("not a supported image type");
  });
});

describe("toUploadChatImageAttachments", () => {
  it("strips client draft id and previewUri for the startTurn wire shape", () => {
    expect(
      toUploadChatImageAttachments([
        {
          id: "client-draft-id",
          type: "image",
          name: "pasted-image.png",
          mimeType: "image/png",
          sizeBytes: 12,
          dataUrl: "data:image/png;base64,AA==",
          previewUri: "file:///tmp/preview.png",
        },
      ]),
    ).toEqual([
      {
        type: "image",
        name: "pasted-image.png",
        mimeType: "image/png",
        sizeBytes: 12,
        dataUrl: "data:image/png;base64,AA==",
      },
    ]);
  });
});

describe("native pasted image cleanup", () => {
  beforeEach(() => {
    files.clear();
  });

  it("recognizes only files created in the native composer paste directory", () => {
    expect(
      isOwnedPastedImageUri(
        "file:///private/var/mobile/Containers/Data/Application/app/tmp/shuv2code-composer-paste/id.png",
      ),
    ).toBe(true);
    expect(isOwnedPastedImageUri("file:///private/var/mobile/photos/id.png")).toBe(false);
    expect(isOwnedPastedImageUri("https://example.com/shuv2code-composer-paste/id.png")).toBe(
      false,
    );
  });

  it("converts owned files to data-backed previews and deletes the source", async () => {
    const uri =
      "file:///private/var/mobile/Containers/Data/Application/app/tmp/shuv2code-composer-paste/id.png";
    files.set(uri, { base64: "aGVsbG8=", deleted: false });

    const attachments = await convertPastedImagesToAttachments({
      uris: [uri],
      existingCount: 0,
    });

    expect(attachments).toEqual([
      expect.objectContaining({
        dataUrl: "data:image/png;base64,aGVsbG8=",
        previewUri: "data:image/png;base64,aGVsbG8=",
      }),
    ]);
    expect(files.get(uri)?.deleted).toBe(true);
  });

  it("deletes rejected and overflow owned files without deleting user-owned files", async () => {
    const rejected =
      "file:///private/var/mobile/Containers/Data/Application/app/tmp/shuv2code-composer-paste/bad.png";
    const overflow =
      "file:///private/var/mobile/Containers/Data/Application/app/tmp/shuv2code-composer-paste/overflow.png";
    const userOwned = "file:///private/var/mobile/photos/library.png";
    files.set(rejected, { base64: "", deleted: false });
    files.set(overflow, { base64: "aGVsbG8=", deleted: false });
    files.set(userOwned, { base64: "aGVsbG8=", deleted: false });

    await convertPastedImagesToAttachments({
      uris: [rejected, overflow, userOwned],
      existingCount: PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 1,
    });

    expect(files.get(rejected)?.deleted).toBe(true);
    expect(files.get(overflow)?.deleted).toBe(true);
    expect(files.get(userOwned)?.deleted).toBe(false);
  });
});
