import { createAssetEnvironmentAtoms } from "@shuv2code/client-runtime/state/assets";

import { connectionAtomRuntime } from "../connection/runtime";

export const assetEnvironment = createAssetEnvironmentAtoms(connectionAtomRuntime);
