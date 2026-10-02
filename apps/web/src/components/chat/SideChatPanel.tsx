import { useAtomValue } from "@effect/atom-react";
import type { LegendListRef } from "@legendapp/list/react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { derivePendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import {
  ProviderDriverKind,
  ThreadId,
  type ChatFileAttachment,
  type ModelSelection,
  type OrchestrationV2ProjectedTurnItem,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type ResolvedKeybindingsConfig,
  type RuntimeMode,
  type RuntimeRequestId,
  type ScopedThreadRef,
  type ServerProvider,
  type SideChatSnapshot,
} from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { AsyncResult } from "effect/unstable/reactivity";
import { MessagesSquare } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { resolveShortcutCommand } from "../../keybindings";
import { getAppModelOptionsForInstance } from "../../modelSelection";
import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { useRightPanelStore } from "../../rightPanelStore";
import { deriveTimelineEntriesFromVisibleTurnItems } from "../../session-logic";
import { sideChatEnvironment } from "../../state/sideChat";
import { useAtomCommand } from "../../state/use-atom-command";
import { resolveComposerInteractionMode } from "../ChatView.logic";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ChatCanvasContext } from "./ChatCanvasContext";
import { ComposerFooterModeControls, runtimeModeOptions } from "./ComposerFooterModeControls";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { ComposerSurface } from "./ComposerSurface";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import { MessagesTimeline } from "./MessagesTimeline";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { SideChatFocusContext } from "./sideChatFocus";
import { TraitsPicker } from "./TraitsPicker";
import { useComposerMenuState } from "./useComposerMenuState";

export interface SideChatPanelProps {
  /** The parent thread the side chat forks. */
  threadRef: ScopedThreadRef;
  /** From the side-chat tab; null until the server has created the fork. */
  sideChatId: string | null;
  parentTitle: string;
  providerStatuses: ReadonlyArray<ServerProvider>;
  settings: UnifiedSettings;
  keybindings: ResolvedKeybindingsConfig;
  resolvedTheme: "light" | "dark";
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onFileOpen: (attachment: ChatFileAttachment) => void;
}

const CODEX_DRIVER = ProviderDriverKind.make("codex");
const EMPTY_CONTEXT_RECORDS = new Map<string, never>();
const noop = () => {};
const noopAsync = async () => {};

/** Parents whose side chat is being created, so remounts do not fork twice. */
const startingParents = new Set<string>();

/** Composer state that outlives the panel while another tab is selected. */
interface SideChatDraft {
  readonly prompt: string;
  readonly modelSelection?: ModelSelection;
  readonly interactionMode?: ProviderInteractionMode;
  readonly runtimeMode?: RuntimeMode;
}
const draftsBySideChatId = new Map<string, SideChatDraft>();

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** Codex's native side conversation for one parent thread, shown in the right panel. */
export function SideChatPanel(props: SideChatPanelProps) {
  return (
    <SideChatFocusContext value={true}>
      <section
        data-side-chat="true"
        aria-label="Side chat"
        className="flex h-full min-h-0 flex-col outline-none"
        tabIndex={-1}
        onPointerDown={(event) => {
          // Keep keyboard shortcuts scoped here after a click on non-focusable content.
          if (
            !(event.target instanceof HTMLElement) ||
            event.target.closest('button,a,input,textarea,[contenteditable],[tabindex="0"]')
          )
            return;
          event.currentTarget.focus({ preventScroll: true });
        }}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-border/50 px-4 py-2.5">
          <MessagesSquare className="size-3.5 text-muted-foreground" />
          <span className="text-xs font-medium">Side chat</span>
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            From {props.parentTitle}
          </span>
          <Tooltip>
            <TooltipTrigger render={<span className="text-3xs text-muted-foreground" />}>
              Temporary
            </TooltipTrigger>
            <TooltipPopup className="max-w-64">
              Closing this tab ends the side chat. It is not saved to your threads.
            </TooltipPopup>
          </Tooltip>
        </div>
        {props.sideChatId ? (
          <SideChatSubscription key={props.sideChatId} {...props} sideChatId={props.sideChatId} />
        ) : (
          <SideChatStarter threadRef={props.threadRef} />
        )}
      </section>
    </SideChatFocusContext>
  );
}

/** Asks the server for the parent's side chat and records its id on the tab. */
function useStartSideChat(threadRef: ScopedThreadRef) {
  const open = useAtomCommand(sideChatEnvironment.open, { reportFailure: false });
  const close = useAtomCommand(sideChatEnvironment.close, { reportFailure: false });
  const [error, setError] = useState<string | null>(null);
  const start = useCallback(() => {
    const key = scopedThreadKey(threadRef);
    if (startingParents.has(key)) return;
    startingParents.add(key);
    setError(null);
    void open({
      environmentId: threadRef.environmentId,
      input: { parentThreadId: threadRef.threadId },
    }).then((result) => {
      startingParents.delete(key);
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          setError(errorMessage(squashAtomCommandFailure(result), "Could not start a side chat."));
        }
        return;
      }
      const { sideChatId } = result.value;
      // The tab closed while the fork was starting; do not leave an invisible conversation.
      if (!useRightPanelStore.getState().setSideChatId(threadRef, sideChatId)) {
        void close({
          environmentId: threadRef.environmentId,
          input: { parentThreadId: threadRef.threadId, sideChatId },
        });
      }
    });
  }, [close, open, threadRef]);
  return { start, error };
}

function SideChatStarter({ threadRef }: { threadRef: ScopedThreadRef }) {
  const { start, error } = useStartSideChat(threadRef);
  const failed = error !== null;
  useEffect(() => {
    if (!failed) start();
  }, [failed, start]);
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      {failed ? (
        <>
          <p className="max-w-72 text-xs leading-relaxed text-muted-foreground">{error}</p>
          <Button size="sm" variant="outline" onClick={start}>
            Try again
          </Button>
        </>
      ) : (
        <>
          <Spinner />
          <p className="text-sm text-muted-foreground">Starting side chat…</p>
        </>
      )}
    </div>
  );
}

function SideChatEnded({ threadRef }: { threadRef: ScopedThreadRef }) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border/50 p-4">
      <p className="text-xs text-muted-foreground">This side chat has ended.</p>
      <Button
        size="sm"
        variant="outline"
        // Clearing the id makes the panel fork a fresh copy of the parent conversation.
        onClick={() => useRightPanelStore.getState().setSideChatId(threadRef, null)}
      >
        Start new side chat
      </Button>
    </div>
  );
}

function SideChatSubscription(props: SideChatPanelProps & { sideChatId: string }) {
  const result = useAtomValue(
    sideChatEnvironment.state({
      environmentId: props.threadRef.environmentId,
      input: {
        parentThreadId: props.threadRef.threadId,
        sideChatId: ThreadId.make(props.sideChatId),
      },
    }),
  );
  const snapshot = Option.getOrNull(AsyncResult.value(result));
  // An unknown side chat (closed elsewhere, or the server restarted) is an ending, not an error.
  const failure = AsyncResult.isFailure(result) ? squashAtomCommandFailure(result) : null;
  const ended =
    snapshot?.status === "closed" ||
    (failure !== null && Predicate.isTagged(failure, "SideChatError"));
  const failureMessage =
    failure !== null && !ended ? errorMessage(failure, "The side chat is unavailable.") : null;

  if (snapshot === null) {
    return (
      <div className="flex flex-1 flex-col">
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          {ended || failureMessage ? (
            failureMessage ? (
              <p role="alert" className="max-w-72 text-xs text-destructive-foreground">
                {failureMessage}
              </p>
            ) : null
          ) : (
            <>
              <Spinner />
              <p className="text-sm text-muted-foreground">Loading side chat…</p>
            </>
          )}
        </div>
        {ended || failureMessage ? <SideChatEnded threadRef={props.threadRef} /> : null}
      </div>
    );
  }
  return (
    <SideChatConversation
      {...props}
      snapshot={snapshot}
      ended={ended || failureMessage !== null}
      failureMessage={failureMessage}
    />
  );
}

function SideChatConversation({
  snapshot,
  ended,
  failureMessage,
  ...props
}: SideChatPanelProps & {
  snapshot: SideChatSnapshot;
  ended: boolean;
  failureMessage: string | null;
}) {
  const send = useAtomCommand(sideChatEnvironment.send, { reportFailure: false });
  const interrupt = useAtomCommand(sideChatEnvironment.interrupt, { reportFailure: false });
  const respond = useAtomCommand(sideChatEnvironment.respond, { reportFailure: false });
  const environmentId = props.threadRef.environmentId;
  const target = { parentThreadId: snapshot.parentThreadId, sideChatId: snapshot.sideChatId };

  const [draft, setDraftState] = useState<SideChatDraft>(
    () => draftsBySideChatId.get(snapshot.sideChatId) ?? { prompt: "" },
  );
  const updateDraft = useCallback(
    (update: (current: SideChatDraft) => SideChatDraft) => {
      setDraftState((current) => {
        const next = update(current);
        draftsBySideChatId.set(snapshot.sideChatId, next);
        return next;
      });
    },
    [snapshot.sideChatId],
  );
  useEffect(() => {
    if (ended) draftsBySideChatId.delete(snapshot.sideChatId);
  }, [ended, snapshot.sideChatId]);

  const modelSelection = draft.modelSelection ?? snapshot.modelSelection;
  const runtimeMode = draft.runtimeMode ?? snapshot.runtimeMode;
  const [cursor, setCursor] = useState(draft.prompt.length);
  const [sending, setSending] = useState(false);
  const [respondingRequestIds, setRespondingRequestIds] = useState<RuntimeRequestId[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [liveFollow, setLiveFollow] = useState(true);
  const [modelPickerOpen, setModelPickerOpen] = useComposerMenuState(false);
  const editorRef = useRef<ComposerPromptEditorHandle | null>(null);
  const listRef = useRef<LegendListRef | null>(null);

  const starting = snapshot.status === "starting";
  const running = snapshot.status === "running";
  const composerLocked = ended || starting;

  const providerStatus =
    props.providerStatuses.find((status) => status.instanceId === modelSelection.instanceId) ??
    null;
  const { enabled: interactionModeEnabled, interactionMode } = resolveComposerInteractionMode({
    planModeEnabled: props.settings.planModeEnabled,
    provider: providerStatus,
    interactionMode: draft.interactionMode ?? snapshot.interactionMode,
  });
  const supportedRuntimeModes = providerStatus?.supportedRuntimeModes;
  const compatibleRuntimeModeOptions =
    supportedRuntimeModes && supportedRuntimeModes.length > 0
      ? runtimeModeOptions.filter((option) => supportedRuntimeModes.includes(option.mode))
      : runtimeModeOptions;
  // Side chats keep the parent's provider instance; only its model and traits can change.
  const instanceEntries = useMemo(
    () =>
      deriveProviderInstanceEntries(props.providerStatuses).filter(
        (entry) => entry.instanceId === modelSelection.instanceId,
      ),
    [props.providerStatuses, modelSelection.instanceId],
  );
  const modelOptionsByInstance = useMemo(
    () =>
      new Map(
        instanceEntries.map((entry) => [
          entry.instanceId,
          getAppModelOptionsForInstance(props.settings, entry, modelSelection.model),
        ]),
      ),
    [instanceEntries, props.settings, modelSelection.model],
  );

  const timelineEntries = useMemo(() => {
    const visibleTurnItems = snapshot.turnItems.map(
      (item, position): OrchestrationV2ProjectedTurnItem => ({
        position,
        visibility: "local",
        sourceThreadId: snapshot.sideChatId,
        sourceItemId: item.id,
        item,
      }),
    );
    return deriveTimelineEntriesFromVisibleTurnItems({ visibleTurnItems, optimisticMessages: [] });
  }, [snapshot.sideChatId, snapshot.turnItems]);
  const activeTurnStartedAt = useMemo(() => {
    if (!running) return null;
    const latestUserMessage = snapshot.turnItems.findLast((item) => item.type === "user_message");
    if (!latestUserMessage) return null;
    return DateTime.formatIso(latestUserMessage.startedAt ?? latestUserMessage.updatedAt);
  }, [running, snapshot.turnItems]);

  const pending = useMemo(
    () =>
      derivePendingThreadRequests({
        runtimeRequests: snapshot.runtimeRequests,
        turnItems: snapshot.turnItems,
      }),
    [snapshot.runtimeRequests, snapshot.turnItems],
  );
  const approval = pending.approvals[0];
  const question = pending.userInputs[0];
  const [answerState, setAnswerState] = useState<{
    requestId: string;
    answers: Record<string, PendingUserInputDraftAnswer>;
    index: number;
  }>({ requestId: "", answers: {}, index: 0 });
  const answers = answerState.requestId === question?.requestId ? answerState.answers : {};
  const questionIndex = answerState.requestId === question?.requestId ? answerState.index : 0;
  const progress = question
    ? derivePendingUserInputProgress(question.questions, answers, questionIndex)
    : null;
  const questionResponding = question ? respondingRequestIds.includes(question.requestId) : false;

  const respondToRequest = async (
    requestId: RuntimeRequestId,
    response: { decision: ProviderApprovalDecision } | { answers: Record<string, unknown> },
  ) => {
    setRespondingRequestIds((current) => [...current, requestId]);
    setError(null);
    const result = await respond({ environmentId, input: { ...target, requestId, ...response } });
    setRespondingRequestIds((current) => current.filter((id) => id !== requestId));
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setError(errorMessage(squashAtomCommandFailure(result), "Could not send the response."));
    }
    return result;
  };
  const handleInterrupt = () => {
    void interrupt({ environmentId, input: target }).then((result) => {
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        setError(errorMessage(squashAtomCommandFailure(result), "Could not stop the side chat."));
      }
    });
  };
  const advanceQuestion = async () => {
    if (!question || !progress?.canAdvance || questionResponding) return;
    if (!progress.isLastQuestion) {
      setAnswerState({ requestId: question.requestId, answers, index: questionIndex + 1 });
      return;
    }
    const resolvedAnswers = buildPendingUserInputAnswers(question.questions, answers);
    if (resolvedAnswers) await respondToRequest(question.requestId, { answers: resolvedAnswers });
  };
  const submit = async () => {
    if (question) {
      await advanceQuestion();
      return;
    }
    const prompt = draft.prompt.trim();
    if (sending || running || composerLocked || approval || !prompt) return;
    setSending(true);
    setError(null);
    const result = await send({
      environmentId,
      input: {
        ...target,
        input: prompt,
        modelSelection,
        interactionMode,
        runtimeMode,
      },
    });
    setSending(false);
    if (result._tag === "Success") {
      // The server now reports the sent selection, so the local overrides are spent.
      updateDraft((current) => (current.prompt === draft.prompt ? { prompt: "" } : current));
      setCursor(0);
      setLiveFollow(true);
    } else if (!isAtomCommandInterrupted(result)) {
      setError(errorMessage(squashAtomCommandFailure(result), "Could not send the message."));
    }
  };
  const prompt = progress ? progress.customAnswer : draft.prompt;
  const updatePrompt = (value: string) => {
    if (question && progress?.activeQuestion) {
      const id = progress.activeQuestion.id;
      setAnswerState({
        requestId: question.requestId,
        index: questionIndex,
        answers: { ...answers, [id]: setPendingUserInputCustomAnswer(answers[id], value) },
      });
    } else {
      updateDraft((current) => ({ ...current, prompt: value }));
    }
  };
  const visibleError = error ?? failureMessage ?? snapshot.error ?? null;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(event) => {
        if (event.defaultPrevented || event.nativeEvent.isComposing) return;
        const command = resolveShortcutCommand(event.nativeEvent, props.keybindings);
        if (command === "modelPicker.toggle" && !composerLocked) {
          event.preventDefault();
          event.stopPropagation();
          setModelPickerOpen((open) => !open);
        } else if (command === "thread.stop" && running) {
          event.preventDefault();
          event.stopPropagation();
          handleInterrupt();
        }
      }}
    >
      <div className="relative min-h-0 flex-1">
        {timelineEntries.length === 0 ? (
          <div className="flex h-full items-center justify-center px-8 text-center text-xs leading-relaxed text-muted-foreground">
            {starting ? "Starting side chat…" : "Ask a question about the conversation so far."}
          </div>
        ) : (
          // The main chat's canvas tracks its own timeline; this one must not register there.
          <ChatCanvasContext value={null}>
            <MessagesTimeline
              isWorking={running}
              activeTurnInProgress={running}
              activeTurnStartedAt={activeTurnStartedAt}
              listRef={listRef}
              timelineEntries={timelineEntries}
              latestRun={null}
              turnDiffSummaries={[]}
              // The parent's key keeps thread-scoped lookups (links, PRs) on the parent;
              // the display key keeps scroll memory separate from the main timeline.
              routeThreadKey={scopedThreadKey(props.threadRef)}
              displayThreadKey={`side-chat:${snapshot.sideChatId}`}
              onOpenTurnDiff={noop}
              onOpenThread={noop}
              onForkFromRun={noopAsync}
              onRollbackCheckpoint={noop}
              supportsConversationRollback={false}
              onRevertToTurnCount={noop}
              isRevertingCheckpoint={false}
              onImageExpand={props.onImageExpand}
              onFileOpen={props.onFileOpen}
              activeThreadEnvironmentId={environmentId}
              markdownCwd={snapshot.cwd}
              resolvedTheme={props.resolvedTheme}
              timestampFormat={props.settings.timestampFormat}
              workspaceRoot={snapshot.cwd}
              providerStatuses={props.providerStatuses}
              runs={[]}
              anchorMessageId={null}
              onAnchorReady={noop}
              onAnchorSizeChanged={noop}
              contentInsetEndAdjustment={0}
              liveFollowEnabled={liveFollow}
              onIsAtEndChange={setLiveFollow}
              onManualNavigation={() => setLiveFollow(false)}
            />
          </ChatCanvasContext>
        )}
      </div>
      {ended ? (
        <SideChatEnded threadRef={props.threadRef} />
      ) : (
        <form
          className="shrink-0 p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {visibleError ? (
            <p role="alert" className="mb-2 text-xs text-destructive-foreground">
              {visibleError}
            </p>
          ) : null}
          {approval ? (
            <div className="mb-2 flex flex-col gap-2 rounded-lg border border-border p-2">
              <ComposerPendingApprovalPanel
                approval={approval}
                pendingCount={pending.approvals.length}
              />
              <div className="flex flex-wrap justify-end gap-1">
                <ComposerPendingApprovalActions
                  requestId={approval.requestId}
                  options={approval.options}
                  isResponding={respondingRequestIds.includes(approval.requestId)}
                  canRespond={approval.responseCapability === "live"}
                  onRespondToApproval={(requestId, decision) =>
                    respondToRequest(requestId, { decision })
                  }
                />
              </div>
            </div>
          ) : null}
          <ComposerPendingUserInputPanel
            pendingUserInputs={[...pending.userInputs]}
            respondingRequestIds={respondingRequestIds}
            answers={answers}
            questionIndex={questionIndex}
            onToggleOption={(questionId, value) => {
              const current = question?.questions.find((item) => item.id === questionId);
              if (!question || !current) return;
              setAnswerState({
                requestId: question.requestId,
                index: questionIndex,
                answers: {
                  ...answers,
                  [questionId]: togglePendingUserInputOptionSelection(
                    current,
                    answers[questionId],
                    value,
                  ),
                },
              });
            }}
            onAdvance={() => void advanceQuestion()}
            onDismiss={(requestId) => void respondToRequest(requestId, { answers: {} })}
          />
          <ComposerSurface.Shell>
            <ComposerSurface.Host>
              <ComposerSurface.Main>
                <ComposerPromptEditor
                  ariaLabel="Side chat message"
                  value={prompt}
                  cursor={cursor}
                  richTextEnabled={props.settings.composerRichTextEnabled}
                  contextRecords={EMPTY_CONTEXT_RECORDS}
                  skills={[]}
                  disabled={
                    composerLocked ||
                    sending ||
                    !!approval ||
                    progress?.activeQuestion?.allowCustomAnswer === false
                  }
                  placeholder={question ? "Type your answer…" : "Ask a side question…"}
                  containerClassName="px-4 pt-3 pb-2"
                  placeholderClassName="px-4 pt-3 pb-2"
                  className="max-h-48 min-h-16 overflow-y-auto text-sm outline-none"
                  onChange={(value, nextCursor) => {
                    updatePrompt(value);
                    setCursor(nextCursor);
                  }}
                  onCommandKeyDown={(key, event) => {
                    if (key !== "Enter" || event.shiftKey || event.isComposing) return false;
                    event.preventDefault();
                    void submit();
                    return true;
                  }}
                  onPaste={noop}
                  editorRef={editorRef}
                />
                <div className="flex flex-wrap items-center gap-1 px-2 pb-2">
                  <ProviderModelPicker
                    activeInstanceId={modelSelection.instanceId}
                    model={modelSelection.model}
                    lockedProvider={CODEX_DRIVER}
                    instanceEntries={instanceEntries}
                    modelOptionsByInstance={modelOptionsByInstance}
                    keybindings={props.keybindings}
                    size="xs"
                    isComposerOwned
                    disabled={composerLocked}
                    open={modelPickerOpen}
                    onOpenChange={setModelPickerOpen}
                    onInstanceModelChange={(_, model) =>
                      updateDraft((current) => ({
                        ...current,
                        modelSelection: { instanceId: modelSelection.instanceId, model },
                      }))
                    }
                  />
                  <TraitsPicker
                    provider={CODEX_DRIVER}
                    instanceId={modelSelection.instanceId}
                    models={providerStatus?.models ?? []}
                    model={modelSelection.model}
                    prompt={prompt}
                    onPromptChange={updatePrompt}
                    modelOptions={modelSelection.options}
                    planModeEnabled={interactionMode === "plan"}
                    size="xs"
                    isComposerOwned
                    onModelOptionsChange={(options) =>
                      updateDraft((current) => ({
                        ...current,
                        modelSelection: {
                          instanceId: modelSelection.instanceId,
                          model: modelSelection.model,
                          ...(options ? { options } : {}),
                        },
                      }))
                    }
                  />
                  <ComposerFooterModeControls
                    size="xs"
                    showInteractionModeToggle={interactionModeEnabled}
                    interactionMode={interactionMode}
                    runtimeMode={runtimeMode}
                    runtimeModeOptions={compatibleRuntimeModeOptions}
                    onToggleInteractionMode={() =>
                      updateDraft((current) => ({
                        ...current,
                        interactionMode: interactionMode === "plan" ? "default" : "plan",
                      }))
                    }
                    onRuntimeModeChange={(mode) =>
                      updateDraft((current) => ({ ...current, runtimeMode: mode }))
                    }
                  />
                  <div className="ml-auto">
                    <ComposerPrimaryActions
                      compact
                      pendingAction={
                        progress
                          ? {
                              questionIndex,
                              isLastQuestion: progress.isLastQuestion,
                              canAdvance: progress.canAdvance,
                              isResponding: questionResponding,
                              isComplete: progress.isComplete,
                            }
                          : null
                      }
                      isRunning={running}
                      canInterrupt={running}
                      showPlanFollowUpPrompt={false}
                      promptHasText={prompt.trim().length > 0}
                      isSendBusy={sending}
                      sendDisabledReason={
                        starting
                          ? "The side chat is still starting"
                          : approval
                            ? "Respond to the approval first"
                            : running
                              ? "Wait for the side chat to finish"
                              : null
                      }
                      isConnecting={false}
                      isEnvironmentUnavailable={false}
                      isPreparingWorktree={false}
                      hasSendableContent={prompt.trim().length > 0}
                      onPreviousPendingQuestion={() => {
                        if (question) {
                          setAnswerState({
                            requestId: question.requestId,
                            answers,
                            index: Math.max(0, questionIndex - 1),
                          });
                        }
                      }}
                      onInterrupt={handleInterrupt}
                      onImplementPlanInNewThread={noop}
                    />
                  </div>
                </div>
              </ComposerSurface.Main>
            </ComposerSurface.Host>
          </ComposerSurface.Shell>
        </form>
      )}
    </div>
  );
}

export default SideChatPanel;
