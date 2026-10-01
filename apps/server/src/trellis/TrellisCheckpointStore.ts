// @effect-diagnostics nodeBuiltinImport:off
/**
 * TrellisCheckpointStore - Trellis snapshots as V2 checkpoints.
 *
 * Decorates `CheckpointStore`: a cwd in a Trellis project is checkpointed by
 * a Trellis `turn` snapshot of its workspace, tagged with the checkpoint ref,
 * and everything else goes to the Git store. `trellis_checkpoint_refs` maps
 * each ref to its snapshot; a ref is captured only once it is mapped (and,
 * for a scope's ordinal 0, the baseline every later diff starts from,
 * pinned), so it stays captured after retention removed the snapshot and is
 * never recaptured from newer files. A capture interrupted after Trellis took
 * the snapshot finds it again by its tag instead of taking another.
 *
 * Restores are Trellis rollbacks (an idea's folder, or the whole dedicated
 * workspace with a container restart). Diffs of a project that is a Git
 * repository come from Git through hidden refs built from the snapshot
 * itself, so they describe the same instant a restore returns to; other
 * diffs compare the two snapshots' directories. Every read of a snapshot
 * directory, and every restore, holds a protection (a pin taken for the
 * duration) so maintenance cannot delete the snapshot meanwhile.
 *
 * @module trellis/TrellisCheckpointStore
 */
import * as NodePath from "node:path";

import type { CheckpointRef, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { CheckpointStore } from "../checkpointing/CheckpointStore.ts";
import {
  CheckpointBackendError,
  CheckpointSnapshotUnavailableError,
} from "../checkpointing/Errors.ts";
import { checkpointRefForScopeOrdinal } from "../orchestration-v2/CheckpointService.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "../orchestration-v2/IdAllocator.ts";
import * as ProcessRunner from "../processRunner.ts";
import { Trellis, type TrellisSnapshot, trellisRootOf, trellisWorkspaceOf } from "./Trellis.ts";
import { restoreScopeOf } from "./TrellisRestore.ts";

/** Patches larger than this are not shown (as for v0's Trellis-only turns). */
const MAX_DIFF_BYTES = 5 * 1024 * 1024;

/** The baseline of a checkpoint scope: kept for as long as the thread is. */
const isBaselineRef = (ref: string) => ref.endsWith("/ordinal/0");

const RetiredSnapshotIds = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeRetired = Schema.decodeUnknownOption(RetiredSnapshotIds);
const parseRetired = (text: string | undefined): ReadonlyArray<string> =>
  Option.getOrElse(decodeRetired(text ?? "[]"), () => []);
const encodeRetired = Schema.encodeSync(RetiredSnapshotIds);

interface RefRow {
  readonly target: string;
  readonly snapshot_id: string | null;
  readonly retired_snapshot_ids: string;
}

/**
 * `git diff --no-index` output for two directories made to read like a diff
 * between two commits: run on `a/` and `b/` links with `--no-prefix`, so paths
 * come out as `a/<path>` and `b/<path>`; numstat records are reduced to the
 * one path Git prints for a commit diff.
 */
function normalizeNoIndexNumstat(output: string): string {
  const records = output.split("\0");
  const lines: Array<string> = [];
  for (let index = 0; index < records.length; index += 1) {
    const counts = /^(\d+|-)\t(\d+|-)\t/.exec(records[index]!);
    if (!counts) continue;
    let path = records[index]!.slice(counts[0].length);
    if (path.length === 0) {
      const from = records[index + 1] ?? "";
      const to = records[index + 2] ?? "";
      index += 2;
      path = to === "/dev/null" ? from : to;
    }
    path = path.replace(/^[ab]\//, "");
    if (path.length > 0) lines.push(`${counts[1]}\t${counts[2]}\t${path}`);
  }
  return lines.length === 0 ? "" : `${lines.join("\0")}\0`;
}

/** See `normalizeNoIndexNumstat`; added and deleted files name one side twice. */
function normalizeNoIndexPatch(output: string): string {
  return output.replace(/^diff --git [ab]\/(.*) [ab]\/(.*)$/gm, "diff --git a/$1 b/$2");
}

export interface TrellisCheckpointPinsShape {
  /**
   * Releases what the store keeps for threads that no longer exist (absent
   * from `liveThreadIds`, which was read at `readAt`): their baselines' pins
   * and ref mappings. Also releases read pins a crash left behind. Never
   * fails; what cannot be released now is tried again on the next call.
   */
  readonly reconcile: (input: {
    readonly liveThreadIds: ReadonlyArray<ThreadId>;
    readonly readAt: DateTime.Utc;
  }) => Effect.Effect<void>;
}

/** The lifecycle of the snapshot pins `TrellisCheckpointStore` takes. */
export class TrellisCheckpointPins extends Context.Service<
  TrellisCheckpointPins,
  TrellisCheckpointPinsShape
>()("t3/trellis/TrellisCheckpointStore/TrellisCheckpointPins") {}

/** The part of a checkpoint ref naming its scope. */
const scopeKeyOfRef = (ref: string) => ref.slice(0, ref.lastIndexOf("/ordinal/"));

export const layer: Layer.Layer<
  CheckpointStore | TrellisCheckpointPins,
  never,
  | CheckpointStore
  | SqlClient.SqlClient
  | FileSystem.FileSystem
  | ChildProcessSpawner.ChildProcessSpawner
> = Layer.effectContext(
  Effect.gen(function* () {
    const base = yield* CheckpointStore;
    const trellisOption = yield* Effect.serviceOption(Trellis);
    if (Option.isNone(trellisOption)) {
      return Context.make(CheckpointStore, base).pipe(
        Context.add(TrellisCheckpointPins, { reconcile: () => Effect.void }),
      );
    }
    const trellis = trellisOption.value;
    const sql = yield* SqlClient.SqlClient;
    const fileSystem = yield* FileSystem.FileSystem;
    const processRunner = yield* ProcessRunner.ProcessRunner;

    // `snapshot_id` is null once the ref was deleted (a rollback went past
    // it); the snapshots it named are retired, so a later capture of the same
    // ref never adopts them by their tag.
    yield* sql`
      CREATE TABLE IF NOT EXISTS trellis_checkpoint_refs (
        ref TEXT PRIMARY KEY,
        target TEXT NOT NULL,
        snapshot_id TEXT,
        captured_at TEXT NOT NULL,
        retired_snapshot_ids TEXT NOT NULL DEFAULT '[]'
      )
    `.pipe(Effect.orDie);
    // Baseline pins of captures not yet mapped, recorded before they are
    // taken; the mapping in `trellis_checkpoint_refs` owns them once it exists.
    yield* sql`
      CREATE TABLE IF NOT EXISTS trellis_pending_pins (
        ref TEXT PRIMARY KEY,
        snapshot_id TEXT NOT NULL,
        target TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      )
    `.pipe(Effect.orDie);
    // Pins taken for a read, recorded before they are taken, so a crash
    // mid-read cannot leave a snapshot pinned for good.
    yield* sql`
      CREATE TABLE IF NOT EXISTS trellis_read_pins (
        snapshot_id TEXT PRIMARY KEY,
        target TEXT NOT NULL
      )
    `.pipe(Effect.orDie);

    const backendError = (operation: string) => (cause: { readonly message: string }) =>
      new CheckpointBackendError({ operation, detail: cause.message });

    const readRow = (ref: string) =>
      sql<RefRow>`
        SELECT target, snapshot_id, retired_snapshot_ids
        FROM trellis_checkpoint_refs WHERE ref = ${ref}
      `.pipe(
        Effect.map((rows) => rows[0] ?? null),
        Effect.mapError(backendError("lookup")),
      );

    const isTrellisPath = (cwd: string) =>
      Effect.gen(function* () {
        const path = yield* trellis.canonicalPath(cwd);
        return trellisRootOf(yield* trellis.expectedRoots, path) !== null;
      });

    const snapshotOf = (target: string, id: string) =>
      trellis.listSnapshots(target).pipe(
        Effect.mapError(backendError("snapshot lookup")),
        Effect.map((snapshots) => snapshots.find((snapshot) => snapshot.id === id) ?? null),
      );

    // Protections of one server, by snapshot id: the first pins the snapshot
    // unless it already was, the last unpins what it pinned.
    const protections = new Map<string, { count: number; pinnedHere: boolean }>();
    const protectionLock = yield* Semaphore.make(1);
    const forgetReadPin = (snapshotId: string) =>
      sql`DELETE FROM trellis_read_pins WHERE snapshot_id = ${snapshotId}`.pipe(
        Effect.mapError(backendError("unpin")),
      );
    // Unpins a snapshot; one already gone counts as unpinned.
    const unpin = (target: string, snapshotId: string) =>
      trellis.setSnapshotPinned(snapshotId, false).pipe(
        Effect.asVoid,
        Effect.catch((error) =>
          snapshotOf(target, snapshotId).pipe(
            Effect.flatMap((still) =>
              still === null ? Effect.void : Effect.fail(backendError("unpin")(error)),
            ),
          ),
        ),
      );
    const protect = (
      ref: string,
      target: string,
      snapshotId: string,
    ): Effect.Effect<
      void,
      CheckpointSnapshotUnavailableError | CheckpointBackendError,
      Scope.Scope
    > =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          const held = protections.get(snapshotId);
          if (held !== undefined) {
            held.count += 1;
            return;
          }
          const snapshot = yield* snapshotOf(target, snapshotId);
          const gone = new CheckpointSnapshotUnavailableError({
            checkpointRef: ref,
            detail: `Trellis snapshot ${snapshotId} no longer exists.`,
          });
          if (snapshot === null) return yield* gone;
          const pinnedHere = snapshot.pinned !== true;
          // Pinning happens under the workspace's lock, so once it returns,
          // thinning can no longer remove the snapshot.
          if (pinnedHere) {
            yield* sql`
              INSERT OR REPLACE INTO trellis_read_pins (snapshot_id, target)
              VALUES (${snapshotId}, ${target})
            `.pipe(Effect.mapError(backendError("protect")));
            // A failed pin means it is gone only when Trellis no longer lists it.
            yield* trellis
              .setSnapshotPinned(snapshotId, true)
              .pipe(
                Effect.catch((error) =>
                  snapshotOf(target, snapshotId).pipe(
                    Effect.flatMap((still) =>
                      Effect.fail(still === null ? gone : backendError("protect")(error)),
                    ),
                  ),
                ),
              );
          }
          protections.set(snapshotId, { count: 1, pinnedHere });
        }).pipe(protectionLock.withPermits(1)),
        () =>
          Effect.gen(function* () {
            const held = protections.get(snapshotId);
            if (held === undefined) return;
            held.count -= 1;
            if (held.count > 0) return;
            protections.delete(snapshotId);
            if (held.pinnedHere && !isBaselineRef(ref)) {
              yield* trellis.setSnapshotPinned(snapshotId, false).pipe(
                Effect.andThen(forgetReadPin(snapshotId)),
                Effect.catch((error) =>
                  Effect.logWarning("could not unpin a Trellis checkpoint snapshot", {
                    snapshotId,
                    detail: error.message,
                  }),
                ),
              );
            } else if (held.pinnedHere) {
              yield* forgetReadPin(snapshotId).pipe(Effect.ignore);
            }
          }).pipe(protectionLock.withPermits(1)),
      );

    // `cwd` as it was in `snapshotId`: `<root>/snapshots/<ws>/<snap>/...`
    // mirrors `<root>/workspaces/<ws>/...`.
    const snapshotPathOf = (ref: string, cwd: string, snapshotId: string) =>
      Effect.gen(function* () {
        const roots = yield* trellis.expectedRoots;
        const path = yield* trellis.canonicalPath(cwd);
        const root = trellisRootOf(roots, path);
        const workspaceId = trellisWorkspaceOf(roots, path);
        if (root === null || workspaceId === null) {
          return yield* new CheckpointBackendError({
            operation: "snapshot path",
            detail: `${cwd} is not in a Trellis workspace.`,
          });
        }
        const live = NodePath.join(root, "workspaces", workspaceId);
        const snapshotPath = NodePath.join(
          root,
          "snapshots",
          workspaceId,
          snapshotId,
          NodePath.relative(live, path),
        );
        if (!(yield* fileSystem.exists(snapshotPath).pipe(Effect.orElseSucceed(() => false)))) {
          return yield* new CheckpointSnapshotUnavailableError({
            checkpointRef: ref,
            detail: `Trellis snapshot ${snapshotId} has no ${NodePath.relative(live, path)}.`,
          });
        }
        return snapshotPath;
      });

    const run = (
      operation: string,
      input: ProcessRunner.ProcessRunInput,
      okCodes: ReadonlyArray<number> = [0],
    ) =>
      processRunner.run({ timeout: "60 seconds", ...input }).pipe(
        Effect.mapError(backendError(operation)),
        Effect.flatMap((output) =>
          output.code !== null && okCodes.includes(output.code)
            ? Effect.succeed(output)
            : Effect.fail(
                new CheckpointBackendError({
                  operation,
                  detail: output.stderr.trim() || `${input.command} exited with ${output.code}`,
                }),
              ),
        ),
      );

    // The hidden Git ref of a checkpoint, built from the read-only snapshot
    // (a temporary index, the snapshot as work tree) into the live repository.
    const writeGitRef = (cwd: string, ref: string, snapshotId: string) =>
      Effect.gen(function* () {
        const top = (yield* run("git ref", {
          command: "git",
          args: ["rev-parse", "--show-toplevel"],
          cwd,
        })).stdout.trim();
        const gitDir = (yield* run("git ref", {
          command: "git",
          args: ["rev-parse", "--absolute-git-dir"],
          cwd,
        })).stdout.trim();
        const workTree = yield* snapshotPathOf(ref, top, snapshotId);
        const temp = yield* fileSystem
          .makeTempDirectoryScoped({ prefix: "t3-trellis-checkpoint-" })
          .pipe(Effect.mapError(backendError("git ref")));
        const env = {
          GIT_DIR: gitDir,
          GIT_WORK_TREE: workTree,
          GIT_INDEX_FILE: NodePath.join(temp, "index"),
          GIT_AUTHOR_NAME: "T3 Code",
          GIT_AUTHOR_EMAIL: "t3code@users.noreply.github.com",
          GIT_COMMITTER_NAME: "T3 Code",
          GIT_COMMITTER_EMAIL: "t3code@users.noreply.github.com",
        };
        const git = (args: ReadonlyArray<string>, okCodes?: ReadonlyArray<number>) =>
          run(
            "git ref",
            { command: "git", args: ["-c", "core.fsmonitor=false", ...args], cwd: workTree, env },
            okCodes,
          );
        // Every file the snapshot's own index tracks stays in the tree even
        // when ignore rules match it, as in a commit; read from the snapshot,
        // not the live repository, which a restore may have moved back.
        const tracked = yield* run(
          "git ref",
          {
            command: "git",
            args: ["--git-dir", NodePath.join(workTree, ".git"), "ls-files", "-z"],
            cwd: workTree,
          },
          [0, 128],
        );
        yield* git(["add", "-A", "--", "."]);
        const presentTracked: Array<string> = [];
        for (const path of tracked.code === 0 ? tracked.stdout.split("\0") : []) {
          if (path.length === 0) continue;
          if (
            yield* fileSystem
              .exists(NodePath.join(workTree, path))
              .pipe(Effect.orElseSucceed(() => false))
          ) {
            presentTracked.push(path);
          }
        }
        if (presentTracked.length > 0) {
          yield* run("git ref", {
            command: "git",
            args: [
              "-c",
              "core.fsmonitor=false",
              "add",
              "-f",
              "--pathspec-from-file=-",
              "--pathspec-file-nul",
            ],
            cwd: workTree,
            env,
            stdin: `${presentTracked.join("\0")}\0`,
          });
        }
        const tree = (yield* git(["write-tree"])).stdout.trim();
        const commit = (yield* git([
          "commit-tree",
          tree,
          "-m",
          "T3 Code checkpoint (Trellis snapshot)",
        ])).stdout.trim();
        yield* git(["update-ref", ref, commit]);
      }).pipe(Effect.scoped);

    const capture = (cwd: string, ref: CheckpointRef) =>
      Effect.gen(function* () {
        const row = yield* readRow(ref);
        if (row?.snapshot_id != null) return;
        const retired = parseRetired(row?.retired_snapshot_ids);
        // A snapshot taken by an interrupted capture carries the ref as its tag.
        const tagged = yield* trellis.listSnapshots(cwd).pipe(
          Effect.mapError(backendError("capture")),
          Effect.map((snapshots) =>
            snapshots.findLast(
              (snapshot) => snapshot.turn === ref && !retired.includes(snapshot.id),
            ),
          ),
        );
        const snapshot: TrellisSnapshot =
          tagged ??
          (yield* trellis
            .createSnapshot({ target: cwd, turn: ref })
            .pipe(Effect.mapError(backendError("capture"))));
        if (isBaselineRef(ref) && snapshot.pinned !== true) {
          // Owned before it is taken, so a capture that never finishes still
          // leaves a pin the reconcile can release.
          const recordedAt = DateTime.formatIso(yield* DateTime.now);
          yield* sql`
            INSERT OR REPLACE INTO trellis_pending_pins (ref, snapshot_id, target, recorded_at)
            VALUES (${ref}, ${snapshot.id}, ${cwd}, ${recordedAt})
          `.pipe(Effect.mapError(backendError("capture")));
          yield* trellis
            .setSnapshotPinned(snapshot.id, true)
            .pipe(Effect.mapError(backendError("capture")));
        }
        if (yield* base.isGitRepository(cwd).pipe(Effect.orElseSucceed(() => false))) {
          yield* Effect.scoped(
            protect(ref, cwd, snapshot.id).pipe(Effect.andThen(writeGitRef(cwd, ref, snapshot.id))),
          );
        }
        const capturedAt = DateTime.formatIso(yield* DateTime.now);
        yield* sql`
          INSERT INTO trellis_checkpoint_refs (ref, target, snapshot_id, captured_at)
          VALUES (${ref}, ${cwd}, ${snapshot.id}, ${capturedAt})
          ON CONFLICT (ref) DO UPDATE SET
            target = excluded.target,
            snapshot_id = excluded.snapshot_id,
            captured_at = excluded.captured_at
        `.pipe(Effect.mapError(backendError("capture")));
        // The mapping owns the baseline's pin from here.
        yield* sql`DELETE FROM trellis_pending_pins WHERE ref = ${ref}`.pipe(
          Effect.mapError(backendError("capture")),
        );
      });

    /**
     * Where `ref` lives: a mapped Trellis snapshot, only a Git ref (taken
     * before this store, or by a capture interrupted before mapping, which
     * is finished here), or nowhere.
     */
    const backendOf = (cwd: string, ref: CheckpointRef) =>
      Effect.gen(function* () {
        const row = yield* readRow(ref);
        if (row?.snapshot_id != null) return "trellis" as const;
        if (row !== null) return "none" as const;
        const isGit = yield* base.isGitRepository(cwd).pipe(Effect.orElseSucceed(() => false));
        if (!isGit || !(yield* base.hasCheckpointRef({ cwd, checkpointRef: ref }))) {
          return "none" as const;
        }
        const tagged = yield* trellis.listSnapshots(cwd).pipe(
          Effect.mapError(backendError("lookup")),
          Effect.map((snapshots) => snapshots.some((snapshot) => snapshot.turn === ref)),
        );
        if (!tagged) return "git" as const;
        yield* capture(cwd, ref);
        return "trellis" as const;
      });

    /** The mapped snapshot of `ref`, protected until the scope closes. */
    const protectedSnapshot = (ref: CheckpointRef) =>
      Effect.gen(function* () {
        const row = yield* readRow(ref);
        if (row?.snapshot_id == null) {
          return yield* new CheckpointSnapshotUnavailableError({
            checkpointRef: ref,
            detail: "no Trellis snapshot was captured for it.",
          });
        }
        yield* protect(ref, row.target, row.snapshot_id);
        return { target: row.target, snapshotId: row.snapshot_id };
      });

    // A restore of a folder whose `.git` is inside it brings back the `.git`
    // of the snapshot, which predates the ref built from that very snapshot
    // (and any later ones); such a ref is built again from its snapshot.
    const ensureGitRef = (cwd: string, ref: CheckpointRef) =>
      Effect.gen(function* () {
        const present = yield* run(
          "git ref",
          { command: "git", args: ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd },
          [0, 1],
        );
        if (present.code === 0) return;
        const { snapshotId } = yield* protectedSnapshot(ref);
        yield* writeGitRef(cwd, ref, snapshotId);
      }).pipe(Effect.scoped);

    const trellisDiff = (input: Parameters<CheckpointStore["Service"]["diffCheckpoints"]>[0]) =>
      Effect.gen(function* () {
        const from = yield* protectedSnapshot(input.fromCheckpointRef);
        const to = yield* protectedSnapshot(input.toCheckpointRef);
        const fromPath = yield* snapshotPathOf(input.fromCheckpointRef, input.cwd, from.snapshotId);
        const toPath = yield* snapshotPathOf(input.toCheckpointRef, input.cwd, to.snapshotId);
        const links = yield* fileSystem
          .makeTempDirectoryScoped({ prefix: "t3-trellis-diff-" })
          .pipe(Effect.mapError(backendError("diff")));
        yield* fileSystem
          .symlink(fromPath, NodePath.join(links, "a"))
          .pipe(
            Effect.andThen(fileSystem.symlink(toPath, NodePath.join(links, "b"))),
            Effect.mapError(backendError("diff")),
          );
        const numstat = input.format === "numstat";
        const output = yield* run(
          "diff",
          {
            command: "git",
            args: [
              "diff",
              "--no-index",
              "--no-prefix",
              ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
              ...(numstat ? ["--numstat", "-z"] : ["--patch"]),
              "a/",
              "b/",
            ],
            cwd: links,
            maxOutputBytes: MAX_DIFF_BYTES,
            outputMode: "truncate",
          },
          [0, 1],
        );
        if (output.stdoutTruncated) return "";
        return numstat
          ? normalizeNoIndexNumstat(output.stdout)
          : normalizeNoIndexPatch(output.stdout);
      }).pipe(Effect.scoped);

    const reconcile: TrellisCheckpointPinsShape["reconcile"] = (input) =>
      Effect.gen(function* () {
        // Read and filtered under the protection lock, so a read taking its
        // pin now has either finished (and is in memory) or not yet started.
        yield* Effect.gen(function* () {
          const readPins = yield* sql<{ readonly snapshot_id: string; readonly target: string }>`
            SELECT snapshot_id, target FROM trellis_read_pins
          `.pipe(Effect.mapError(backendError("reconcile")));
          yield* Effect.forEach(
            readPins.filter((pin) => !protections.has(pin.snapshot_id)),
            (pin) =>
              unpin(pin.target, pin.snapshot_id).pipe(
                Effect.andThen(forgetReadPin(pin.snapshot_id)),
                Effect.catch((error) =>
                  Effect.logWarning("could not release a stale Trellis read pin", {
                    snapshotId: pin.snapshot_id,
                    detail: error.message,
                  }),
                ),
              ),
            { discard: true },
          );
        }).pipe(protectionLock.withPermits(1));

        const ids = yield* IdAllocatorV2;
        const live = new Set<string>();
        for (const threadId of input.liveThreadIds) {
          const scopeId = yield* ids.allocate.checkpointScope({ threadId, name: "root" });
          live.add(scopeKeyOfRef(checkpointRefForScopeOrdinal({ scopeId, ordinalWithinScope: 0 })));
        }
        // Rows captured after the thread list was read may belong to a
        // thread it does not know yet.
        const rows = yield* sql<{
          readonly ref: string;
          readonly target: string;
          readonly snapshot_id: string | null;
        }>`
          SELECT ref, target, snapshot_id FROM trellis_checkpoint_refs
          WHERE captured_at < ${DateTime.formatIso(input.readAt)}
        `.pipe(Effect.mapError(backendError("reconcile")));
        const pending = yield* sql<{
          readonly ref: string;
          readonly target: string;
          readonly snapshot_id: string;
        }>`
          SELECT ref, target, snapshot_id FROM trellis_pending_pins
          WHERE recorded_at < ${DateTime.formatIso(input.readAt)}
        `.pipe(Effect.mapError(backendError("reconcile")));
        for (const pin of pending) {
          if (live.has(scopeKeyOfRef(pin.ref))) continue;
          yield* unpin(pin.target, pin.snapshot_id).pipe(
            Effect.andThen(
              sql`DELETE FROM trellis_pending_pins WHERE ref = ${pin.ref}`.pipe(
                Effect.mapError(backendError("reconcile")),
              ),
            ),
            Effect.catch((error) =>
              Effect.logWarning("could not release an unfinished Trellis baseline pin", {
                ref: pin.ref,
                detail: error.message,
              }),
            ),
          );
        }
        for (const row of rows) {
          if (live.has(scopeKeyOfRef(row.ref))) continue;
          yield* Effect.gen(function* () {
            if (row.snapshot_id !== null && isBaselineRef(row.ref)) {
              yield* unpin(row.target, row.snapshot_id);
            }
            yield* sql`DELETE FROM trellis_checkpoint_refs WHERE ref = ${row.ref}`.pipe(
              Effect.mapError(backendError("reconcile")),
            );
          }).pipe(
            Effect.catch((error) =>
              Effect.logWarning("could not release a deleted thread's Trellis checkpoint", {
                ref: row.ref,
                detail: error.message,
              }),
            ),
          );
        }
      }).pipe(
        Effect.provide(idAllocatorLayer),
        Effect.catchCause((cause) =>
          Effect.logWarning("could not reconcile Trellis checkpoint pins", { cause }),
        ),
      );

    return Context.make(TrellisCheckpointPins, { reconcile }).pipe(
      Context.add(
        CheckpointStore,
        CheckpointStore.of({
          isGitRepository: base.isGitRepository,
          isCheckpointable: (cwd) =>
            Effect.flatMap(isTrellisPath(cwd), (trellisPath) =>
              trellisPath ? Effect.succeed(true) : base.isCheckpointable(cwd),
            ),
          hasCheckpointRef: (input) =>
            Effect.flatMap(isTrellisPath(input.cwd), (trellisPath) =>
              trellisPath
                ? backendOf(input.cwd, input.checkpointRef).pipe(
                    Effect.map((kind) => kind !== "none"),
                  )
                : base.hasCheckpointRef(input),
            ),
          captureCheckpoint: (input) =>
            Effect.flatMap(isTrellisPath(input.cwd), (trellisPath) =>
              trellisPath
                ? capture(input.cwd, input.checkpointRef).pipe(
                    // As v0 did: a busy or restarting Trellis gets two more tries.
                    Effect.retry({ times: 2, schedule: Schedule.spaced("1 second") }),
                  )
                : base.captureCheckpoint(input),
            ),
          reserve: (input) =>
            Effect.flatMap(isTrellisPath(input.cwd), (trellisPath) =>
              trellisPath
                ? Effect.gen(function* () {
                    if ((yield* backendOf(input.cwd, input.checkpointRef)) === "git") {
                      return yield* base.reserve(input);
                    }
                    yield* protectedSnapshot(input.checkpointRef);
                    const scope = yield* restoreScopeOf(trellis, input.cwd);
                    return { endsSessionsIn: scope?.restartsWorkspace ? scope.path : null };
                  })
                : base.reserve(input),
            ),
          restoreCheckpoint: (input) =>
            Effect.flatMap(isTrellisPath(input.cwd), (trellisPath) =>
              trellisPath
                ? Effect.gen(function* () {
                    if ((yield* backendOf(input.cwd, input.checkpointRef)) === "git") {
                      return yield* base.restoreCheckpoint(input);
                    }
                    const row = yield* readRow(input.checkpointRef);
                    if (row?.snapshot_id == null) return { restored: false };
                    const snapshotId = row.snapshot_id;
                    const { undoSnapshot } = yield* trellis
                      .rollback({ target: input.cwd, snapshot: snapshotId })
                      .pipe(Effect.mapError(backendError("restore")));
                    return {
                      restored: true,
                      notice:
                        undoSnapshot === null
                          ? `Restored the files from Trellis snapshot ${snapshotId}.`
                          : `Restored the files from Trellis snapshot ${snapshotId}. To undo, run \`trellis rollback --target ${input.cwd} ${undoSnapshot}\`.`,
                    };
                  })
                : base.restoreCheckpoint(input),
            ),
          diffCheckpoints: (input) =>
            Effect.flatMap(isTrellisPath(input.cwd), (trellisPath) =>
              Effect.gen(function* () {
                if (!trellisPath) return yield* base.diffCheckpoints(input);
                // Git projects keep diffing through the hidden refs, so ignore
                // rules apply as without Trellis.
                if (
                  yield* base.isGitRepository(input.cwd).pipe(Effect.orElseSucceed(() => false))
                ) {
                  yield* ensureGitRef(input.cwd, input.fromCheckpointRef);
                  yield* ensureGitRef(input.cwd, input.toCheckpointRef);
                  return yield* base.diffCheckpoints(input);
                }
                return yield* trellisDiff(input);
              }),
            ),
          deleteCheckpointRefs: (input) =>
            Effect.flatMap(isTrellisPath(input.cwd), (trellisPath) =>
              Effect.gen(function* () {
                if (!trellisPath) return yield* base.deleteCheckpointRefs(input);
                if (
                  yield* base.isGitRepository(input.cwd).pipe(Effect.orElseSucceed(() => false))
                ) {
                  yield* base.deleteCheckpointRefs(input);
                }
                // The snapshots stay to Trellis retention.
                for (const ref of input.checkpointRefs) {
                  const row = yield* readRow(ref);
                  if (row?.snapshot_id == null) continue;
                  const retired = [...parseRetired(row.retired_snapshot_ids), row.snapshot_id];
                  const retiredText = encodeRetired(retired);
                  yield* sql`
                UPDATE trellis_checkpoint_refs
                SET snapshot_id = NULL, retired_snapshot_ids = ${retiredText}
                WHERE ref = ${ref}
              `.pipe(Effect.mapError(backendError("delete")));
                }
              }),
            ),
        }),
      ),
    );
  }),
).pipe(Layer.provide(ProcessRunner.layer));
