import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";

import { makeKeyedCoalescingWorker } from "./KeyedCoalescingWorker.ts";

describe("makeKeyedCoalescingWorker", () => {
  it.live("waits for latest work enqueued during active processing before draining the key", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const releaseSecond = yield* Deferred.make<void>();

        const worker = yield* makeKeyedCoalescingWorker<string, string, never, never>({
          merge: (_current, next) => next,
          process: (key, value) =>
            Effect.gen(function* () {
              processed.push(`${key}:${value}`);

              if (value === "first") {
                yield* Deferred.succeed(firstStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseFirst);
              }

              if (value === "second") {
                yield* Deferred.succeed(secondStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseSecond);
              }
            }),
        });

        yield* worker.enqueue("terminal-1", "first");
        yield* Deferred.await(firstStarted);

        const drained = yield* Deferred.make<void>();
        yield* Effect.forkChild(
          worker
            .drainKey("terminal-1")
            .pipe(Effect.tap(() => Deferred.succeed(drained, undefined).pipe(Effect.orDie))),
        );

        yield* worker.enqueue("terminal-1", "second");
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(secondStarted);

        expect(yield* Deferred.isDone(drained)).toBe(false);

        yield* Deferred.succeed(releaseSecond, undefined);
        yield* Deferred.await(drained);

        expect(processed).toEqual(["terminal-1:first", "terminal-1:second"]);
      }),
    ),
  );

  it.live("requeues pending work for a key after a processor failure and keeps draining", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const firstStarted = yield* Deferred.make<void>();
        const releaseFailure = yield* Deferred.make<void>();
        const secondProcessed = yield* Deferred.make<void>();

        const worker = yield* makeKeyedCoalescingWorker<string, string, string, never>({
          merge: (_current, next) => next,
          process: (key, value) =>
            Effect.gen(function* () {
              processed.push(`${key}:${value}`);

              if (value === "first") {
                yield* Deferred.succeed(firstStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseFailure);
                return yield* Effect.fail("boom");
              }

              if (value === "second") {
                yield* Deferred.succeed(secondProcessed, undefined).pipe(Effect.orDie);
              }
            }),
        });

        yield* worker.enqueue("terminal-1", "first");
        yield* Deferred.await(firstStarted);
        yield* worker.enqueue("terminal-1", "second");
        yield* Deferred.succeed(releaseFailure, undefined);
        yield* Deferred.await(secondProcessed);
        yield* worker.drainKey("terminal-1");

        expect(processed).toEqual(["terminal-1:first", "terminal-1:second"]);
      }),
    ),
  );

  it.live("flushes one key without waiting behind unrelated queued work", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const slowStarted = yield* Deferred.make<void>();
        const releaseSlow = yield* Deferred.make<void>();
        const urgentStarted = yield* Deferred.make<void>();

        const worker = yield* makeKeyedCoalescingWorker<string, string, never, never>({
          merge: (_current, next) => next,
          process: (key, value, context) =>
            Effect.gen(function* () {
              processed.push(`${key}:${value}:${context.flush ? "flush" : "normal"}`);
              if (key === "slow") {
                yield* Deferred.succeed(slowStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseSlow);
              }
              if (key === "urgent") {
                yield* Deferred.succeed(urgentStarted, undefined).pipe(Effect.orDie);
              }
            }),
        });

        yield* worker.enqueue("slow", "first");
        yield* Deferred.await(slowStarted);
        yield* worker.enqueue("queued", "second");
        yield* worker.enqueue("urgent", "terminal");

        const flushed = yield* Effect.forkChild(worker.flushKey("urgent"));
        yield* Deferred.await(urgentStarted);

        expect(processed).toEqual(["slow:first:normal", "urgent:terminal:flush"]);

        yield* Fiber.join(flushed);
        yield* Deferred.succeed(releaseSlow, undefined);
        yield* worker.drainKey("queued");

        expect(processed).toEqual([
          "slow:first:normal",
          "urgent:terminal:flush",
          "queued:second:normal",
        ]);
      }),
    ),
  );

  it.live("stops active processing when its owning scope closes", () =>
    Effect.gen(function* () {
      const workerScope = yield* Scope.make();
      const started = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const neverRelease = yield* Deferred.make<void>();

      const worker = yield* makeKeyedCoalescingWorker<string, string, never, never>({
        merge: (_current, next) => next,
        process: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined).pipe(Effect.orDie);
            yield* Deferred.await(neverRelease);
          }).pipe(
            Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined).pipe(Effect.orDie)),
          ),
      }).pipe(Effect.provideService(Scope.Scope, workerScope));

      yield* worker.enqueue("child", "progress");
      yield* Deferred.await(started);
      yield* Scope.close(workerScope, Exit.void);

      expect(yield* Deferred.isDone(interrupted)).toBe(true);
    }),
  );
});
