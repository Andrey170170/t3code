import * as Schema from "effect/Schema";

/**
 * Trellis is an optional local workspace service. These contracts cover the
 * client-facing operations; Trellis-managed projects are ordinary T3 projects
 * whose `workspaceRoot` lies inside `<root>/workspaces/`.
 */
export class TrellisError extends Schema.TaggedError<TrellisError>()("TrellisError", {
  message: Schema.String,
}) {}

/**
 * `disabled`: the integration is off in this environment's settings.
 * `unavailable`: it is on, but the Trellis service does not answer.
 * `ready`: Trellis actions work. Trellis UI shows only when `ready`.
 */
export const TrellisState = Schema.Literals(["disabled", "unavailable", "ready"]);
export type TrellisState = typeof TrellisState.Type;

export const TrellisStatus = Schema.Struct({
  state: TrellisState,
  /** Where Trellis project paths live; also reported while disabled or unavailable when known. */
  root: Schema.optionalKey(Schema.String),
  /**
   * Every root Trellis project paths may live under, including earlier roots,
   * so clients recognize those projects while Trellis is off or down.
   */
  knownRoots: Schema.Array(Schema.String),
  /** The API socket the server uses or would use. */
  socketPath: Schema.String,
});
export type TrellisStatus = typeof TrellisStatus.Type;
