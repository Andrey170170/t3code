import * as Effect from "effect/Effect";

import { TrellisCheckpointTool } from "../../../trellis/TrellisCheckpointTool.ts";
import { TrellisGraduation } from "../../../trellis/TrellisGraduation.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { TrellisToolkit } from "./tools.ts";

const handlers = {
  trellis_checkpoint: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const tool = yield* TrellisCheckpointTool;
      return yield* tool.checkpoint(scope, input);
    }),
  trellis_graduate: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const graduation = yield* TrellisGraduation;
      return yield* graduation.graduateFromTool(scope, input);
    }),
} satisfies Parameters<typeof TrellisToolkit.toLayer>[0];

export const TrellisToolkitHandlersLive = TrellisToolkit.toLayer(handlers);
