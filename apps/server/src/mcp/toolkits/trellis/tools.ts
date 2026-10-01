import {
  TrellisCheckpointMcpFailure,
  TrellisCheckpointMcpInput,
  TrellisCheckpointMcpResult,
  TrellisDiscardForkMcpFailure,
  TrellisDiscardForkMcpInput,
  TrellisDiscardForkMcpResult,
  TrellisGraduateMcpFailure,
  TrellisGraduateMcpInput,
  TrellisGraduateMcpResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";

import { TrellisCheckpointTool } from "../../../trellis/TrellisCheckpointTool.ts";
import { TrellisWorkers } from "../../../trellis/TrellisWorkers.ts";
import { TrellisGraduation } from "../../../trellis/TrellisGraduation.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const TrellisCheckpoint = Tool.make("trellis_checkpoint", {
  description:
    "Take a Trellis checkpoint of this thread's dedicated Trellis workspace: a consistent point forks start from (delegate_task with workspace: {fork: {from: 'latest'}} spawns a worker in a fork of it; spawning never stops the workspace, so checkpoint once, then spawn as many workers as you need). A checkpoint stops everything running in the workspace (you included), snapshots it and restarts it, so this tool ends the current turn: call it as the last action of a turn and stop. The result (the checkpoint, and the processes the stop ended, to restart if you still need them) arrives as this thread's next message, which continues the conversation. It refuses while other threads are mid-turn in the workspace, naming them. Pass interrupt: true to also end the turns of your own delegated workers (and theirs), who continue after the restart; it never ends other threads. Ideas take no checkpoints. Use this instead of running `trellis checkpoint` in a shell.",
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

const TrellisDiscardFork = Tool.make("trellis_discard_fork", {
  description:
    "Discard a fork of this Trellis project that you or your workers spawned (a worker's fork you merged or no longer need; other forks are refused): it moves to the Trellis trash with its threads archived; it is refused while a thread works in it. Merge first if you want its work: `trellis merge-brief FORK` gives the incoming copy to fetch from, then `trellis merged FORK SNAP` records the merge. A discarded fork expires after 30 days unless it holds unmerged work (uncommitted changes, or commits the parent lacks), which keeps it until the user purges it; the result says which. With requestPurge, also ask the user to purge it for good (agents never purge); calling it on a fork already in the trash only files the request.",
  parameters: TrellisDiscardForkMcpInput,
  success: TrellisDiscardForkMcpResult,
  failure: TrellisDiscardForkMcpFailure,
  failureMode: "return",
  dependencies: [McpInvocationContext.McpInvocationContext, TrellisWorkers],
})
  .annotate(Tool.Title, "Discard a Trellis fork")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const TrellisGraduate = Tool.make("trellis_graduate", {
  description:
    "Call this tool directly, as a tool call (it is not a shell command), to graduate this thread's Trellis idea into its own project instead of running `trellis graduate`: a dedicated Trellis workspace from a base (Trellis's default unless you pass base), starting with a copy of the idea's folder. Every active thread of the idea moves there with its conversation. The graduation copies the idea's folder, so this tool ends the current turn: call it as the last action of a turn and stop. The outcome arrives as this thread's next message, in the new project, saying where it now works. Packages installed while it was an idea do not come along; `trellis changes --graduation` lists them. It refuses while other threads are mid-turn in the idea, naming them. Pass interrupt: true to also end the turns of your own delegated workers (and theirs), who continue in the new project; it never ends other threads. Running `trellis graduate` in a shell does not end your turn or continue you in the project.",
  parameters: TrellisGraduateMcpInput,
  success: TrellisGraduateMcpResult,
  failure: TrellisGraduateMcpFailure,
  failureMode: "return",
  dependencies: [McpInvocationContext.McpInvocationContext, TrellisGraduation],
})
  .annotate(Tool.Title, "Graduate the Trellis idea")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const TrellisToolkit = Toolkit.make(TrellisCheckpoint, TrellisDiscardFork, TrellisGraduate);
