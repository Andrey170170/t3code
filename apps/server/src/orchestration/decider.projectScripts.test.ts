import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  type ProjectScript,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asEventId = (value: string): EventId => EventId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
it.layer(NodeServices.layer)("decider project scripts", (it) => {
  it.effect("emits empty scripts on project.create", () =>
    Effect.gen(function* () {
      const now = "2026-01-01T00:00:00.000Z";
      const readModel = createEmptyReadModel(now);

      const result = yield* decideOrchestrationCommand({
        command: {
          type: "project.create",
          commandId: CommandId.make("cmd-project-create-scripts"),
          projectId: asProjectId("project-scripts"),
          title: "Scripts",
          workspaceRoot: "/tmp/scripts",
          createdAt: now,
        },
        readModel,
      });

      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("project.created");
      expect((event.payload as { scripts: unknown[] }).scripts).toEqual([]);
    }),
  );

  it.effect("propagates scripts in project.meta.update payload", () =>
    Effect.gen(function* () {
      const now = "2026-01-01T00:00:00.000Z";
      const initial = createEmptyReadModel(now);
      const readModel = yield* projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create-scripts"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-scripts"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.make("cmd-project-create-scripts"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-project-create-scripts"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-scripts"),
          title: "Scripts",
          workspaceRoot: "/tmp/scripts",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      const scripts = [
        {
          id: "lint",
          name: "Lint",
          command: "bun run lint",
          icon: "lint",
          runOnWorktreeCreate: false,
        },
      ] as const;

      const result = yield* decideOrchestrationCommand({
        command: {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-project-update-scripts"),
          projectId: asProjectId("project-scripts"),
          scripts: Array.from(scripts),
        },
        readModel,
      });

      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("project.meta-updated");
      expect((event.payload as { scripts?: unknown[] }).scripts).toEqual(scripts);
    }),
  );

  const script = (id: string): ProjectScript => ({
    id,
    name: "Install dependencies",
    command: "vp i",
    icon: "configure",
    runOnWorktreeCreate: false,
  });

  const projectWithScripts = (scripts: ReadonlyArray<ProjectScript>) => {
    const now = "2026-01-01T00:00:00.000Z";
    return projectEvent(createEmptyReadModel(now), {
      sequence: 1,
      eventId: asEventId("evt-legacy-scripts"),
      aggregateKind: "project",
      aggregateId: asProjectId("project-scripts"),
      type: "project.created",
      occurredAt: now,
      commandId: CommandId.make("cmd-legacy-scripts"),
      causationEventId: null,
      correlationId: CommandId.make("cmd-legacy-scripts"),
      metadata: {},
      payload: {
        projectId: asProjectId("project-scripts"),
        title: "Scripts",
        workspaceRoot: "/tmp/scripts",
        defaultModelSelection: null,
        scripts,
        createdAt: now,
        updatedAt: now,
      },
    });
  };

  for (const id of ["install-javascript-dependencies", "A", "a.b", "a b", "-a", "a".repeat(25)]) {
    it.effect(`rejects a new script ID that cannot have a shortcut: ${id}`, () =>
      Effect.gen(function* () {
        const readModel = yield* projectWithScripts([]);
        const failure = yield* Effect.flip(
          decideOrchestrationCommand({
            readModel,
            command: {
              type: "project.meta.update",
              commandId: CommandId.make("cmd-invalid-script"),
              projectId: asProjectId("project-scripts"),
              scripts: [script("lint"), script(id)],
            },
          }),
        );
        expect(failure).toMatchObject({ _tag: "OrchestrationCommandInvariantError" });
        expect(failure.message).toContain("Script ID");
        expect(failure.message).toContain("24");
        expect(readModel.projects[0]?.scripts).toEqual([]);
      }),
    );
  }

  it.effect("accepts a script ID at the shortcut length limit", () =>
    Effect.gen(function* () {
      const readModel = yield* projectWithScripts([]);
      const scripts = [script("a".repeat(24))];
      const result = yield* decideOrchestrationCommand({
        readModel,
        command: {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-valid-script"),
          projectId: asProjectId("project-scripts"),
          scripts,
        },
      });
      const event = Array.isArray(result) ? result[0] : result;
      expect(event.payload).toMatchObject({ scripts });
    }),
  );

  it.effect(
    "keeps legacy scripts readable, editable and removable while allowing valid additions",
    () =>
      Effect.gen(function* () {
        const legacy = script("install-javascript-dependencies");
        const readModel = yield* projectWithScripts([legacy]);
        expect(readModel.projects[0]?.scripts).toEqual([legacy]);
        for (const scripts of [[{ ...legacy, command: "vp install" }, script("lint")], []]) {
          const result = yield* decideOrchestrationCommand({
            readModel,
            command: {
              type: "project.meta.update",
              commandId: CommandId.make("cmd-repair-script"),
              projectId: asProjectId("project-scripts"),
              scripts,
            },
          });
          const event = Array.isArray(result) ? result[0] : result;
          expect(event.payload).toMatchObject({ scripts });
        }
        const failure = yield* Effect.flip(
          decideOrchestrationCommand({
            readModel,
            command: {
              type: "project.meta.update",
              commandId: CommandId.make("cmd-new-invalid-script"),
              projectId: asProjectId("project-scripts"),
              scripts: [legacy, script("another.invalid.id")],
            },
          }),
        );
        expect(failure).toMatchObject({ _tag: "OrchestrationCommandInvariantError" });
      }),
  );

  it.effect("propagates project icon metadata in project.meta.update", () =>
    Effect.gen(function* () {
      const now = "2026-01-01T00:00:00.000Z";
      const readModel = yield* projectEvent(createEmptyReadModel(now), {
        sequence: 1,
        eventId: asEventId("evt-project-create-favicon"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-favicon"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.make("cmd-project-create-favicon"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-project-create-favicon"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-favicon"),
          title: "Favicon",
          workspaceRoot: "/tmp/favicon",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      const result = yield* decideOrchestrationCommand({
        command: {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-project-update-favicon"),
          projectId: asProjectId("project-favicon"),
          faviconPath: "brand/icon.svg",
          projectIcon: { kind: "lucide", name: "alarm-clock", color: "violet" },
        },
        readModel,
      });

      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("project.meta-updated");
      expect((event.payload as { faviconPath?: string }).faviconPath).toBe("brand/icon.svg");
      expect((event.payload as { projectIcon?: unknown }).projectIcon).toEqual({
        kind: "lucide",
        name: "alarm-clock",
        color: "violet",
      });
    }),
  );

  it.effect("rejects project.create for an active workspace root that already exists", () =>
    Effect.gen(function* () {
      const now = "2026-01-01T00:00:00.000Z";
      const initial = createEmptyReadModel(now);
      const readModel = yield* projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-existing"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.make("cmd-project-create"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-project-create"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-existing"),
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      const failure = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "project.create",
            commandId: CommandId.make("cmd-project-create-duplicate-root"),
            projectId: asProjectId("project-duplicate-root"),
            title: "Duplicate Project",
            workspaceRoot: "/tmp/project/",
            createdAt: now,
          },
          readModel,
        }),
      );

      expect(failure.message).toContain(
        "Active project 'project-existing' already exists for workspace root '/tmp/project'.",
      );
    }),
  );

  it.effect("rejects project.meta.update when moving onto another active workspace root", () =>
    Effect.gen(function* () {
      const now = "2026-01-01T00:00:00.000Z";
      const initial = createEmptyReadModel(now);
      const withFirstProject = yield* projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create-first"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-first"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.make("cmd-project-create-first"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-project-create-first"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-first"),
          title: "First",
          workspaceRoot: "/tmp/project-first",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });
      const readModel = yield* projectEvent(withFirstProject, {
        sequence: 2,
        eventId: asEventId("evt-project-create-second"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-second"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.make("cmd-project-create-second"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-project-create-second"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-second"),
          title: "Second",
          workspaceRoot: "/tmp/project-second",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      const failure = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "project.meta.update",
            commandId: CommandId.make("cmd-project-update-duplicate-root"),
            projectId: asProjectId("project-second"),
            workspaceRoot: "/tmp/project-first",
          },
          readModel,
        }),
      );

      expect(failure.message).toContain(
        "Active project 'project-first' already exists for workspace root '/tmp/project-first'.",
      );
    }),
  );

  it.effect("rechecks agent endpoints after queued moves, archives, and deletions", () =>
    Effect.gen(function* () {
      const now = "2026-09-08T00:00:00.000Z";
      let readModel = createEmptyReadModel(now);
      const commands: OrchestrationCommand[] = [
        {
          type: "project.create",
          commandId: CommandId.make("agent-project"),
          projectId: ProjectId.make("agent-project"),
          title: "Project",
          workspaceRoot: "/tmp/agent-project",
          createdAt: now,
        },
        ...["source", "target"].map((id): OrchestrationCommand => ({
          type: "thread.create",
          commandId: CommandId.make(`create-${id}`),
          threadId: ThreadId.make(id),
          projectId: ProjectId.make("agent-project"),
          title: id,
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          createdAt: now,
        })),
      ];
      for (const command of commands) {
        const decided = yield* decideOrchestrationCommand({ command, readModel });
        for (const event of Array.isArray(decided) ? decided : [decided]) {
          readModel = yield* projectEvent(readModel, {
            ...event,
            sequence: readModel.snapshotSequence + 1,
          });
        }
      }
      const command: Extract<OrchestrationCommand, { type: "thread.turn.start" }> = {
        type: "thread.turn.start",
        commandId: CommandId.make("queued-agent-turn"),
        threadId: ThreadId.make("target"),
        agentOrigin: { threadId: ThreadId.make("source"), operationId: "operation" },
        message: {
          messageId: MessageId.make("queued-message"),
          role: "user",
          text: "Review",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      };
      const accepted = yield* decideOrchestrationCommand({ command, readModel });
      expect(Array.isArray(accepted) ? accepted : [accepted]).toHaveLength(2);
      const targetMoved = {
        ...readModel,
        threads: readModel.threads.map((thread) =>
          thread.id === "target"
            ? { ...thread, projectId: ProjectId.make("different-project") }
            : thread,
        ),
      };
      const changedModels = [
        targetMoved,
        { ...readModel, threads: readModel.threads.filter((thread) => thread.id !== "source") },
        ...["source", "target"].flatMap((id) => [
          {
            ...readModel,
            threads: readModel.threads.map((thread) =>
              thread.id === id ? { ...thread, deletedAt: now } : thread,
            ),
          },
          {
            ...readModel,
            threads: readModel.threads.map((thread) =>
              thread.id === id ? { ...thread, archivedAt: now } : thread,
            ),
          },
        ]),
      ];
      for (const changed of changedModels) {
        const rejected = yield* decideOrchestrationCommand({ command, readModel: changed }).pipe(
          Effect.result,
        );
        expect(rejected._tag).toBe("Failure");
        if (rejected._tag === "Failure")
          expect(rejected.failure._tag).toBe("OrchestrationCommandInvariantError");
      }
      const { agentOrigin: _origin, ...humanCommand } = command;
      const human = yield* decideOrchestrationCommand({
        command: humanCommand,
        readModel: targetMoved,
      });
      expect(Array.isArray(human) ? human : [human]).toHaveLength(2);
    }),
  );

  it.effect("emits user message and turn-start-requested events for thread.turn.start", () =>
    Effect.gen(function* () {
      const now = "2026-01-01T00:00:00.000Z";
      const initial = createEmptyReadModel(now);
      const withProject = yield* projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-1"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.make("cmd-project-create"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-project-create"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-1"),
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });
      const readModel = yield* projectEvent(withProject, {
        sequence: 2,
        eventId: asEventId("evt-thread-create"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.created",
        occurredAt: now,
        commandId: CommandId.make("cmd-thread-create"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-thread-create"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId("message-user-1"),
            role: "user",
            text: "hello",
            attachments: [],
          },
          modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
            { id: "reasoningEffort", value: "high" },
            { id: "fastMode", value: true },
          ]),
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        },
        readModel,
      });

      expect(Array.isArray(result)).toBe(true);
      const events = Array.isArray(result) ? result : [result];
      expect(events).toHaveLength(2);
      expect(events[0]?.type).toBe("thread.message-sent");
      expect(events[0]?.payload).not.toHaveProperty("agentOrigin");
      const agentOrigin = { threadId: ThreadId.make("source-agent"), operationId: "operation-1" };
      const sourceThread = { ...readModel.threads[0]!, id: agentOrigin.threadId };
      const delegatedModel = { ...readModel, threads: [...readModel.threads, sourceThread] };
      const delegated = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("delegated-start"),
          threadId: ThreadId.make("thread-1"),
          agentOrigin,
          message: {
            messageId: asMessageId("delegated-message"),
            role: "user",
            text: "Review this",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        },
        readModel: delegatedModel,
      });
      const delegatedEvents = Array.isArray(delegated) ? delegated : [delegated];
      expect(delegatedEvents[0]?.payload).toHaveProperty("agentOrigin", agentOrigin);
      expect(delegatedEvents[1]?.payload).toHaveProperty("agentOrigin", agentOrigin);
      let replayed = readModel;
      for (const [index, event] of delegatedEvents.entries()) {
        replayed = yield* projectEvent(replayed, { ...event, sequence: index + 3 });
      }
      expect(replayed.threads[0]?.messages[0]?.agentOrigin).toEqual(agentOrigin);
      const turnStartEvent = events[1];
      expect(turnStartEvent?.type).toBe("thread.turn-start-requested");
      expect(turnStartEvent?.causationEventId).toBe(events[0]?.eventId ?? null);
      if (turnStartEvent?.type !== "thread.turn-start-requested") {
        return;
      }
      expect(turnStartEvent.payload).toMatchObject({
        threadId: ThreadId.make("thread-1"),
        messageId: asMessageId("message-user-1"),
        modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ]),
        runtimeMode: "approval-required",
      });
    }),
  );

  it.effect("emits thread.runtime-mode-set from thread.runtime-mode.set", () =>
    Effect.gen(function* () {
      const now = "2026-01-01T00:00:00.000Z";
      const initial = createEmptyReadModel(now);
      const withProject = yield* projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-1"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.make("cmd-project-create"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-project-create"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-1"),
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });
      const readModel = yield* projectEvent(withProject, {
        sequence: 2,
        eventId: asEventId("evt-thread-create"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.created",
        occurredAt: now,
        commandId: CommandId.make("cmd-thread-create"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-thread-create"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.runtime-mode.set",
          commandId: CommandId.make("cmd-runtime-mode-set"),
          threadId: ThreadId.make("thread-1"),
          runtimeMode: "approval-required",
          createdAt: now,
        },
        readModel,
      });

      const singleResult = Array.isArray(result) ? null : result;
      if (singleResult === null) {
        throw new Error("Expected a single runtime-mode-set event.");
      }
      expect(singleResult).toMatchObject({
        type: "thread.runtime-mode-set",
        payload: {
          threadId: ThreadId.make("thread-1"),
          runtimeMode: "approval-required",
        },
      });
    }),
  );

  it.effect("emits thread.interaction-mode-set from thread.interaction-mode.set", () =>
    Effect.gen(function* () {
      const now = "2026-01-01T00:00:00.000Z";
      const initial = createEmptyReadModel(now);
      const withProject = yield* projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-1"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.make("cmd-project-create"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-project-create"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-1"),
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });
      const readModel = yield* projectEvent(withProject, {
        sequence: 2,
        eventId: asEventId("evt-thread-create"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.created",
        occurredAt: now,
        commandId: CommandId.make("cmd-thread-create"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-thread-create"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.interaction-mode.set",
          commandId: CommandId.make("cmd-interaction-mode-set"),
          threadId: ThreadId.make("thread-1"),
          interactionMode: "plan",
          createdAt: now,
        },
        readModel,
      });

      const singleResult = Array.isArray(result) ? null : result;
      if (singleResult === null) {
        throw new Error("Expected a single interaction-mode-set event.");
      }
      expect(singleResult).toMatchObject({
        type: "thread.interaction-mode-set",
        payload: {
          threadId: ThreadId.make("thread-1"),
          interactionMode: "plan",
        },
      });
    }),
  );
});
