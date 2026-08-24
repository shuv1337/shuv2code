import { WS_METHODS, type ProviderCompactThreadInput } from "@shuv2code/contracts";

import { request } from "../rpc/client.ts";

export const compactThread = (input: ProviderCompactThreadInput) =>
  request(WS_METHODS.threadCompact, input);
