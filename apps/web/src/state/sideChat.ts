import { createSideChatEnvironmentAtoms } from "@t3tools/client-runtime/state/side-chat";

import { connectionAtomRuntime } from "../connection/runtime";

export const sideChatEnvironment = createSideChatEnvironmentAtoms(connectionAtomRuntime);
