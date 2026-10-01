import {
  TrellisCheckpointMcpFailure,
  TrellisCheckpointMcpInput,
  TrellisCheckpointMcpResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";

import { TrellisCheckpointTool } from "../../../trellis/TrellisCheckpointTool.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const TrellisCheckpoint = Tool.make("trellis_checkpoint", {
  description:
    "Take a Trellis checkpoint of this thread's dedicated Trellis workspace: a consistent point forks start from. A checkpoint stops everything running in the workspace (you included), snapshots it and restarts it, so this tool ends the current turn: call it as the last action of a turn and stop. The result (the checkpoint, and the processes the stop ended, to restart if you still need them) arrives as this thread's next message, which continues the conversation. It refuses while other threads are mid-turn in the workspace, naming them. Pass interrupt: true to also end the turns of your own delegated workers (and theirs), who continue after the restart; it never ends other threads. Ideas take no checkpoints. Use this instead of running `trellis checkpoint` in a shell.",
  parameters: TrellisCheckpointMcpInput,
  success: TrellisCheckpointMcpResult,
  failure: TrellisCheckpointMcpFailure,
  failureMode: "return",
  dependencies: [McpInvocationContext.McpInvocationContext, TrellisCheckpointTool],
})
  .annotate(Tool.Title, "Take a Trellis checkpoint")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const TrellisToolkit = Toolkit.make(TrellisCheckpoint);
