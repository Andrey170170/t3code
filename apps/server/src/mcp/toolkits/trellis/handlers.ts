import * as Effect from "effect/Effect";

import { TrellisCheckpointTool } from "../../../trellis/TrellisCheckpointTool.ts";
import { TrellisWorkers } from "../../../trellis/TrellisWorkers.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { TrellisToolkit } from "./tools.ts";

const handlers = {
  trellis_checkpoint: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const tool = yield* TrellisCheckpointTool;
      return yield* tool.checkpoint(scope, input);
    }),
  trellis_discard_fork: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const workers = yield* TrellisWorkers;
      return yield* workers.discardFork(scope, input);
    }),
} satisfies Parameters<typeof TrellisToolkit.toLayer>[0];

export const TrellisToolkitHandlersLive = TrellisToolkit.toLayer(handlers);
