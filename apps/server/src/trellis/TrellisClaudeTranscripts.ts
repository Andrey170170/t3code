/**
 * TrellisClaudeTranscripts - keeps a Claude session's transcript beside the
 * directory it resumes in.
 *
 * Claude Code stores a session under `<config>/projects/<slug(cwd)>/`: the
 * transcript `<sid>.jsonl` and the `<sid>/` directory (subagents, tool
 * results). `resume` finds a transcript from any cwd, but the SDK's
 * directory-keyed calls (`forkSession(sid, {dir})`, `getSubagentMessages`)
 * look only under `slug(dir)`, so a session that moved to another workspace
 * is relocated before it is used there. Files are renamed, never rewritten:
 * re-serializing a transcript can corrupt the signatures of its thinking
 * blocks, which the API then drops silently. Auto-memory (`memory/`) is
 * copied, without overwriting, into the new slug.
 *
 * @module trellis/TrellisClaudeTranscripts
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

export class TrellisClaudeTranscriptError extends Schema.TaggedError<TrellisClaudeTranscriptError>()(
  "TrellisClaudeTranscriptError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

/** Claude Code's longest project slug before it appends a hash. */
const MAX_SLUG_LENGTH = 200;

/** Claude Code's string hash (Java's `hashCode`), for slugs of long paths. */
function claudeStringHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index++) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return hash;
}

/** The directory name Claude Code keeps a project's sessions under, for a realpath. */
export function claudeProjectSlug(path: string): string {
  const slug = path.replace(/[^a-zA-Z0-9]/g, "-");
  return slug.length <= MAX_SLUG_LENGTH
    ? slug
    : `${slug.slice(0, MAX_SLUG_LENGTH)}-${Math.abs(claudeStringHash(path)).toString(36)}`;
}

const keyedLocks = () => {
  const locks = new Map<string, Semaphore.Semaphore>();
  return (key: string) => {
    const existing = locks.get(key);
    if (existing !== undefined) return existing;
    const created = Semaphore.makeUnsafe(1);
    locks.set(key, created);
    return created;
  };
};
// One relocation per session id at a time, across all callers in the process.
const lockFor = keyedLocks();
// One memory copy per destination at a time: sessions relocating into the
// same workspace copy the same files through the same partial-file names.
const memoryLockFor = keyedLocks();

const fail = (message: string) => (cause: unknown) =>
  new TrellisClaudeTranscriptError({ message, cause });

/**
 * The session's project directory for `cwd`, where `prepare` puts it.
 * `cwd` is resolved to its realpath, as Claude Code does.
 */
export const claudeSessionDirectory = Effect.fn("TrellisClaudeTranscripts.sessionDirectory")(
  function* (input: { readonly configDir: string; readonly cwd: string }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const realCwd = yield* fileSystem
      .realPath(input.cwd)
      .pipe(Effect.orElseSucceed(() => input.cwd));
    return path.join(input.configDir, "projects", claudeProjectSlug(realCwd));
  },
);

/** Copies the files under `from` that `to` lacks; nothing is overwritten. */
const copyMissing = (
  from: string,
  to: string,
): Effect.Effect<void, TrellisClaudeTranscriptError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const info = yield* fileSystem.stat(from).pipe(Effect.orElseSucceed(() => null));
    if (info === null) return;
    if (info.type === "Directory") {
      yield* fileSystem
        .makeDirectory(to, { recursive: true })
        .pipe(Effect.mapError(fail(`Could not create ${to}.`)));
      const names = yield* fileSystem
        .readDirectory(from)
        .pipe(Effect.mapError(fail(`Could not read ${from}.`)));
      for (const name of names) {
        yield* copyMissing(path.join(from, name), path.join(to, name));
      }
      return;
    }
    if (
      info.type !== "File" ||
      (yield* fileSystem.exists(to).pipe(Effect.orElseSucceed(() => true)))
    ) {
      return;
    }
    // Copied beside the target and renamed into place, so an interrupted copy
    // never leaves a partial file that a later call would take as present.
    const partial = path.join(path.dirname(to), `.${path.basename(to)}.trellis-copy`);
    yield* fileSystem
      .copyFile(from, partial)
      .pipe(
        Effect.andThen(fileSystem.rename(partial, to)),
        Effect.mapError(fail(`Could not copy ${from}.`)),
      );
  });

/**
 * Moves session `sessionId`'s transcript and its directory to the project
 * slug of `cwd`, after copying the auto-memory the destination lacks.
 * Idempotent and per artifact: an artifact only at the destination is left
 * alone, so an interrupted relocation finishes on the next call; one found at
 * the destination and elsewhere, or in two other places, is a collision and
 * fails without merging. A session with no transcript anywhere is left to the
 * caller (`hasClaudeTranscript`).
 */
export const prepareClaudeTranscript = (input: {
  readonly configDir: string;
  readonly sessionId: string;
  readonly cwd: string;
}): Effect.Effect<void, TrellisClaudeTranscriptError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const projectsDir = path.join(input.configDir, "projects");
    const destination = yield* claudeSessionDirectory(input);
    const slugs = yield* fileSystem
      .readDirectory(projectsDir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const exists = (file: string) =>
      fileSystem.exists(file).pipe(Effect.orElseSucceed(() => false));

    const moves: Array<{ readonly from: string; readonly to: string }> = [];
    const sources = new Set<string>();
    for (const artifact of [`${input.sessionId}.jsonl`, input.sessionId]) {
      const target = path.join(destination, artifact);
      const holders: Array<string> = [];
      for (const slug of slugs) {
        const directory = path.join(projectsDir, slug);
        if (directory === destination) continue;
        if (yield* exists(path.join(directory, artifact))) holders.push(directory);
      }
      const atDestination = yield* exists(target);
      if (holders.length > 1 || (holders.length === 1 && atDestination)) {
        return yield* new TrellisClaudeTranscriptError({
          message: `Claude session ${input.sessionId} has '${artifact}' in more than one project directory (${[
            ...holders,
            ...(atDestination ? [destination] : []),
          ].join(", ")}); resolve the collision by hand.`,
        });
      }
      const holder = holders[0];
      if (holder !== undefined) {
        sources.add(holder);
        moves.push({ from: path.join(holder, artifact), to: target });
      }
    }
    if (moves.length === 0) return;

    // Memory first: until every artifact has moved, its source still names
    // where the memory comes from, so an interrupted call can finish.
    yield* Effect.forEach(
      sources,
      (source) => copyMissing(path.join(source, "memory"), path.join(destination, "memory")),
      { discard: true },
    ).pipe(memoryLockFor(destination).withPermits(1));
    yield* fileSystem
      .makeDirectory(destination, { recursive: true })
      .pipe(Effect.mapError(fail(`Could not create ${destination}.`)));
    for (const move of moves) {
      yield* fileSystem
        .rename(move.from, move.to)
        .pipe(Effect.mapError(fail(`Could not move ${move.from} to ${move.to}.`)));
    }
    yield* Effect.logInfo("relocated a Claude session to its workspace", {
      sessionId: input.sessionId,
      destination,
      moved: moves.map((move) => move.from),
    });
  }).pipe(lockFor(input.sessionId).withPermits(1));

/** Whether session `sessionId`'s transcript is in the project directory of `cwd`. */
export const hasClaudeTranscript = (input: {
  readonly configDir: string;
  readonly sessionId: string;
  readonly cwd: string;
}): Effect.Effect<boolean, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* claudeSessionDirectory(input);
    return yield* fileSystem
      .exists(path.join(directory, `${input.sessionId}.jsonl`))
      .pipe(Effect.orElseSucceed(() => false));
  });
