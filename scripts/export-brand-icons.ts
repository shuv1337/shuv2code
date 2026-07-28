#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Deterministic build-time asset generator uses direct filesystem and CLI output.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";
import { BRAND_ASSET_PATHS, DEVELOPMENT_PUBLIC_ICON_OVERRIDES } from "./lib/brand-assets.ts";

interface BrandManifest {
  readonly channels: Record<
    "production" | "nightly" | "development",
    { readonly body: string; readonly screen: string; readonly prompt: string }
  >;
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");
const sourcePath = resolve(repositoryRoot, "assets/brand/shuv2code-devil-terminal.svg");

const outputs = {
  production: {
    ios: BRAND_ASSET_PATHS.productionIosIconPng,
    macos: BRAND_ASSET_PATHS.productionMacIconPng,
    universal: BRAND_ASSET_PATHS.productionLinuxIconPng,
    windows: BRAND_ASSET_PATHS.productionWindowsIconIco,
    favicon: BRAND_ASSET_PATHS.productionWebFaviconIco,
    favicon16: BRAND_ASSET_PATHS.productionWebFavicon16Png,
    favicon32: BRAND_ASSET_PATHS.productionWebFavicon32Png,
    touch: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
  },
  nightly: {
    ios: BRAND_ASSET_PATHS.nightlyIosIconPng,
    macos: BRAND_ASSET_PATHS.nightlyMacIconPng,
    universal: BRAND_ASSET_PATHS.nightlyLinuxIconPng,
    windows: BRAND_ASSET_PATHS.nightlyWindowsIconIco,
    favicon: BRAND_ASSET_PATHS.nightlyWebFaviconIco,
    favicon16: BRAND_ASSET_PATHS.nightlyWebFavicon16Png,
    favicon32: BRAND_ASSET_PATHS.nightlyWebFavicon32Png,
    touch: BRAND_ASSET_PATHS.nightlyWebAppleTouchIconPng,
  },
  development: {
    ios: BRAND_ASSET_PATHS.developmentIosIconPng,
    macos: BRAND_ASSET_PATHS.developmentDesktopIconPng,
    universal: BRAND_ASSET_PATHS.developmentUniversalIconPng,
    windows: BRAND_ASSET_PATHS.developmentWindowsIconIco,
    favicon: BRAND_ASSET_PATHS.developmentWebFaviconIco,
    favicon16: BRAND_ASSET_PATHS.developmentWebFavicon16Png,
    favicon32: BRAND_ASSET_PATHS.developmentWebFavicon32Png,
    touch: BRAND_ASSET_PATHS.developmentWebAppleTouchIconPng,
  },
} as const;

function channelMark(source: string, color: string): Buffer {
  return Buffer.from(source.replaceAll("#C45145", color));
}

async function renderMark(source: Buffer, size: number): Promise<Buffer> {
  return sharp(source, { density: 384 })
    .resize(size, size, { fit: "contain" })
    .png({ adaptiveFiltering: false, compressionLevel: 9 })
    .toBuffer();
}

async function renderIos(source: Buffer, background: string, size: number): Promise<Buffer> {
  const markSize = Math.round(size * 0.74);
  const mark = await renderMark(source, markSize);
  return sharp({
    create: { width: size, height: size, channels: 4, background },
  })
    .composite([{ input: mark, gravity: "center" }])
    .png({ adaptiveFiltering: false, compressionLevel: 9 })
    .toBuffer();
}

async function renderMac(source: Buffer, background: string): Promise<Buffer> {
  const card = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="824" height="824"><rect width="824" height="824" rx="180" fill="${background}"/></svg>`,
  );
  const mark = await renderMark(source, 610);
  return sharp({
    create: { width: 1024, height: 1024, channels: 4, background: "#00000000" },
  })
    .composite([
      { input: card, left: 100, top: 100 },
      { input: mark, left: 207, top: 207 },
    ])
    .png({ adaptiveFiltering: false, compressionLevel: 9 })
    .toBuffer();
}

async function generate() {
  const [manifestText, source] = await Promise.all([
    readFile(resolve(repositoryRoot, "brand/shuv2code.brand.json"), "utf8"),
    readFile(sourcePath, "utf8"),
  ]);
  const manifest = JSON.parse(manifestText) as BrandManifest;
  const generated = new Map<string, Buffer>();

  for (const channel of ["production", "nightly", "development"] as const) {
    const colors = manifest.channels[channel];
    const mark = channelMark(source, colors.body);
    const target = outputs[channel];
    const ios = await renderIos(mark, colors.screen, 1024);
    const universal = await renderMark(mark, 1024);
    const icoRenditions = await Promise.all(
      WINDOWS_ICON_SIZES.map(async (size) => ({
        size,
        contents: await renderIos(mark, colors.screen, size),
      })),
    );
    const ico = encodePngIco(icoRenditions);

    generated.set(target.ios, ios);
    generated.set(target.macos, await renderMac(mark, colors.screen));
    generated.set(target.universal, universal);
    generated.set(target.windows, ico);
    generated.set(target.favicon, ico);
    generated.set(target.favicon16, await renderIos(mark, colors.screen, 16));
    generated.set(target.favicon32, await renderIos(mark, colors.screen, 32));
    generated.set(target.touch, await renderIos(mark, colors.screen, 180));

    if (channel === "production") {
      const marketingIcon = await renderIos(mark, colors.screen, 1024);
      const marketingTouchIcon = await renderIos(mark, colors.screen, 180);
      const marketingFavicon16 = await renderIos(mark, colors.screen, 16);
      const marketingFavicon32 = await renderIos(mark, colors.screen, 32);

      generated.set("apps/marketing/public/icon.png", marketingIcon);
      generated.set(
        "apps/marketing/public/icon.webp",
        await sharp(marketingIcon).webp({ lossless: true }).toBuffer(),
      );
      generated.set("apps/marketing/public/apple-touch-icon.png", marketingTouchIcon);
      generated.set(
        "apps/marketing/public/apple-touch-icon.webp",
        await sharp(marketingTouchIcon).webp({ lossless: true }).toBuffer(),
      );
      generated.set("apps/marketing/public/favicon-16x16.png", marketingFavicon16);
      generated.set(
        "apps/marketing/public/favicon-16x16.webp",
        await sharp(marketingFavicon16).webp({ lossless: true }).toBuffer(),
      );
      generated.set("apps/marketing/public/favicon-32x32.png", marketingFavicon32);
      generated.set(
        "apps/marketing/public/favicon-32x32.webp",
        await sharp(marketingFavicon32).webp({ lossless: true }).toBuffer(),
      );
      generated.set("apps/marketing/public/favicon.ico", ico);
    }
  }

  const monochromeSource = await readFile(
    resolve(repositoryRoot, "assets/brand/shuv2code-devil-terminal-monochrome.svg"),
  );
  generated.set(
    "apps/mobile/assets/android-icon-mark.png",
    await renderMark(monochromeSource, 1024),
  );
  generated.set(
    "apps/mobile/assets/android-notification-icon.png",
    await renderMark(monochromeSource, 96),
  );

  for (const override of DEVELOPMENT_PUBLIC_ICON_OVERRIDES) {
    const contents = generated.get(override.sourceRelativePath);
    if (!contents) throw new Error(`Missing generated asset: ${override.sourceRelativePath}`);
    generated.set(override.targetRelativePath, contents);
  }

  const stale: string[] = [];
  for (const [relativePath, expected] of generated) {
    const absolutePath = resolve(repositoryRoot, relativePath);
    if (checkOnly) {
      const actual = await readFile(absolutePath).catch(() => null);
      if (!actual?.equals(expected)) stale.push(relativePath);
    } else {
      await writeFile(absolutePath, expected);
    }
  }

  if (stale.length > 0) {
    throw new Error(
      `Generated brand assets are stale:\n${stale.map((path) => `- ${path}`).join("\n")}`,
    );
  }
  console.log(
    checkOnly
      ? `All ${generated.size} generated brand assets are current.`
      : `Updated ${generated.size} generated brand assets.`,
  );
}

await generate();
