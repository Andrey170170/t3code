import { createCodexThreadCommands } from "@t3tools/client-runtime/state/codex-threads";
import { connectionAtomRuntime } from "../connection/runtime";
export const codexThreads = createCodexThreadCommands(connectionAtomRuntime);
