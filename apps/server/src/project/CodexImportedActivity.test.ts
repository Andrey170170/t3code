import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { CodexAppServerRequestError } from "effect-codex-app-server/errors";
import { makeThreadHistory } from "effect-codex-app-server/thread-history";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import { ProviderSessionDirectoryLive } from "../provider/Layers/ProviderSessionDirectory.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { CodexThreadClient } from "./CodexThreadClient.ts";
import { makeCodexImportedActivity } from "./CodexImportedActivity.ts";

const INSTANCE = ProviderInstanceId.make("codex");
const OLD = "2026-08-20T00:00:00.000Z";
const repository = ProviderSessionRuntime.layer.pipe(Layer.provide(SqlitePersistenceMemory));
const testLayer = Layer.mergeAll(
  NodeServices.layer,
  SqlitePersistenceMemory,
  repository,
  ProviderSessionDirectoryLive.pipe(Layer.provide(repository)),
);
const seed = (id: string, lastActivityAt?: string) =>
  Effect.gen(function* () {
    const directory = yield* ProviderSessionDirectory;
    yield* directory.upsert({
      threadId: ThreadId.make(id),
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: INSTANCE,
      status: "stopped",
      resumeCursor: { threadId: id },
      runtimePayload: {
        marker: "original",
        codexHistoryImport: {
          nativeThreadId: id,
          providerInstanceId: INSTANCE,
          homeIdentity: "shared-home",
          importedAt: "2026-08-28T00:00:00.000Z",
          firstItem: null,
          nextCursor: null,
          ...(lastActivityAt ? { lastActivityAt } : {}),
        },
      },
    });
  });
const fakeClient = (
  read: (id: string) => Effect.Effect<number, CodexAppServerRequestError>,
  catalogIds: ReadonlyArray<string> = [],
  home = "shared-home",
) => {
  const reads: string[] = [];
  const methods: string[] = [];
  let connections = 0;
  const native = makeThreadHistory({
    request: (method, params) =>
      Effect.gen(function* () {
        methods.push(method);
        if (method === "thread/list") {
          if ((params as { archived?: boolean }).archived) return { data: [], nextCursor: null };
          const data = yield* Effect.forEach(catalogIds, (id) => {
            reads.push(id);
            return read(id).pipe(
              Effect.map((updatedAt) => ({
                id,
                cwd: "/tmp",
                modelProvider: "openai",
                preview: "",
                createdAt: 1,
                updatedAt,
              })),
              Effect.orElseSucceed(() => null),
            );
          });
          return { data: data.filter((thread) => thread !== null), nextCursor: null };
        }
        // Reproduce installed Codex 0.153.4: read(false) loses activity and exposes creation time.
        const id = (params as { threadId: string }).threadId;
        return {
          thread: {
            id,
            cwd: "/tmp",
            modelProvider: "openai",
            preview: "",
            createdAt: 1,
            updatedAt: 1,
          },
        };
      }),
  });
  return {
    reads,
    methods,
    connections: () => connections,
    service: CodexThreadClient.of({
      resolveNativeHomeIdentity: () => Effect.succeed(home),
      withClient: (_id, use) =>
        Effect.suspend(() => {
          connections++;
          return use(native);
        }),
    }),
  };
};

it.layer(testLayer)("Codex imported activity", (it) => {
  it.effect(
    "backfills native updatedAt once without replacing concurrent payload fields or changed identities",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const ids = ["saved-activity", "legacy-activity", "raced-activity"].map((id) =>
          ThreadId.make(id),
        );
        yield* seed(ids[0]!, OLD);
        yield* seed(ids[1]!);
        yield* seed(ids[2]!);
        const client = fakeClient(
          (id) =>
            Effect.gen(function* () {
              if (id === "legacy-activity")
                yield* sql`UPDATE provider_session_runtime SET runtime_payload_json = json_set(runtime_payload_json, '$.marker', 'concurrent') WHERE thread_id = ${id}`.pipe(
                  Effect.orDie,
                );
              if (id === "raced-activity")
                yield* sql`UPDATE provider_session_runtime SET runtime_payload_json = json_set(runtime_payload_json, '$.codexHistoryImport.nativeThreadId', 'replacement') WHERE thread_id = ${id}`.pipe(
                  Effect.orDie,
                );
              return Date.parse(OLD) / 1000;
            }),
          ids,
        );
        const lookup = yield* makeCodexImportedActivity.pipe(
          Effect.provideService(CodexThreadClient, client.service),
        );
        const activity = yield* lookup(ids);
        expect(activity.get(ids[0]!)).toBe(OLD);
        expect(activity.get(ids[1]!)).toBe(OLD);
        expect(activity.has(ids[2]!)).toBe(false);
        expect(client.reads).toEqual(ids);
        expect(client.methods).toEqual(["thread/list"]);
        expect(client.connections()).toBe(1);
        const directory = yield* ProviderSessionDirectory;
        expect(
          Option.getOrThrow(yield* directory.getBinding(ids[1]!)).runtimePayload,
        ).toMatchObject({ marker: "concurrent", codexHistoryImport: { lastActivityAt: OLD } });
        // A stale provider lifecycle update must retain the backfilled boundary.
        yield* directory.upsert({
          threadId: ids[1]!,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: INSTANCE,
          status: "stopped",
          runtimePayload: { marker: "new-runtime" },
        });
        const restarted = yield* makeCodexImportedActivity.pipe(
          Effect.provideService(CodexThreadClient, client.service),
        );
        expect((yield* restarted([ids[1]!])).get(ids[1]!)).toBe(OLD);
        expect(client.reads).toHaveLength(3);
      }),
  );

  it.effect(
    "caps backfill at fifty and advances past failed sources without guessing creation time",
    () =>
      Effect.gen(function* () {
        const ids = Array.from({ length: 51 }, (_, index) =>
          ThreadId.make(`missing-${String(index).padStart(3, "0")}`),
        );
        yield* Effect.forEach(ids, (id) => seed(id), { discard: true });
        const client = fakeClient(
          (id) =>
            id === "missing-050"
              ? Effect.succeed(Date.parse(OLD) / 1000)
              : Effect.fail(
                  new CodexAppServerRequestError({
                    method: "thread/read",
                    code: -32000,
                    errorMessage: "Source unavailable",
                  }),
                ),
          ids,
        );
        const lookup = yield* makeCodexImportedActivity.pipe(
          Effect.provideService(CodexThreadClient, client.service),
        );
        expect((yield* lookup(ids)).size).toBe(0);
        expect(client.connections()).toBe(1);
        expect((yield* lookup(ids)).get(ids[50]!)).toBe(OLD);
        expect(client.reads).toHaveLength(51);
        expect((yield* lookup(ids)).size).toBe(1);
        expect(client.reads).toHaveLength(51);
      }),
  );

  it.effect("does not read an import through a provider whose native home changed", () =>
    Effect.gen(function* () {
      yield* seed("moved-home");
      const client = fakeClient(
        () => Effect.succeed(Date.parse(OLD) / 1000),
        ["moved-home"],
        "another-home",
      );
      const lookup = yield* makeCodexImportedActivity.pipe(
        Effect.provideService(CodexThreadClient, client.service),
      );
      expect((yield* lookup([ThreadId.make("moved-home")])).size).toBe(0);
      expect(client.connections()).toBe(0);
      expect(client.reads).toHaveLength(0);
    }),
  );
  it.effect(
    "writes at most fifty missing activity records per sweep while reusing native metadata",
    () =>
      Effect.gen(function* () {
        const ids = Array.from({ length: 51 }, (_, index) =>
          ThreadId.make(`bounded-${String(index).padStart(3, "0")}`),
        );
        yield* Effect.forEach(ids, (id) => seed(id), { discard: true });
        const client = fakeClient(() => Effect.succeed(Date.parse(OLD) / 1000), ids);
        const lookup = yield* makeCodexImportedActivity.pipe(
          Effect.provideService(CodexThreadClient, client.service),
        );
        expect((yield* lookup(ids)).size).toBe(50);
        expect((yield* lookup(ids)).size).toBe(51);
        expect(client.connections()).toBe(1);
        expect(client.methods).toEqual(["thread/list"]);
      }),
  );
});
