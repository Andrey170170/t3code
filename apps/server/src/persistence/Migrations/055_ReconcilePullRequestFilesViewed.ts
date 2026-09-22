import * as Effect from "effect/Effect";

import PullRequestFilesViewed from "./053_PullRequestFilesViewed.ts";
import ReconcileForkSchema from "./053_ReconcileForkSchema.ts";

export default Effect.gen(function* () {
  // Upstream used 53 for viewed files; this fork already used 53–54 for
  // reconciliation. Upstream databases skip our 53, so repair both schemas
  // here without changing either lineage's recorded migration history.
  yield* ReconcileForkSchema;
  yield* PullRequestFilesViewed;
});
