import type { APIRoute } from "astro";

import { buildShuv2CodeProjectFileJsonSchema } from "@shuv2code/shared/shuv2codeProjectFile";

// Rendered only when an explicitly configured marketing deployment is built.
// Local editor support uses the checked-in schemas/shuv2code.schema.json.
export const GET: APIRoute = () =>
  new Response(`${JSON.stringify(buildShuv2CodeProjectFileJsonSchema(), null, 2)}\n`, {
    headers: { "Content-Type": "application/json" },
  });
