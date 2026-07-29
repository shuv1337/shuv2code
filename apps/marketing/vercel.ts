import type { VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  installCommand: "npm install -g vite-plus && vp install --filter '@shuv2code/marketing...'",
  buildCommand: "vp run --filter @shuv2code/marketing build",
  outputDirectory: "dist",
};
