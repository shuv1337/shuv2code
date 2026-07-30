import { createAutomationEnvironmentAtoms } from "@shuv2code/client-runtime/state/automations";

import { connectionAtomRuntime } from "../connection/runtime";

export const automationEnvironment = createAutomationEnvironmentAtoms(connectionAtomRuntime);
