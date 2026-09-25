import { SideChatFocusContext } from "./sideChatFocus";
import { useAtomValue } from "@effect/atom-react";
import type { LegendListRef } from "@legendapp/list/react";
import { derivePendingRequests } from "@t3tools/client-runtime/pending-requests";
import {
  ProviderDriverKind,
  type ChatFileAttachment,
  type ModelSelection,
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
  type ServerProvider,
  type SideChatSnapshot,
} from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Cause from "effect/Cause";
import { GitBranchIcon, MessageSquareIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sideChatEnvironment } from "../../state/sideChat";
import { useAtomCommand } from "../../state/use-atom-command";
import { deriveTimelineEntries, deriveWorkLogEntries } from "../../session-logic";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { getAppModelOptionsForInstance } from "../../modelSelection";
import { resolveShortcutCommand } from "../../keybindings";
import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { useComposerMenuState } from "./useComposerMenuState";
import { MessagesTimeline } from "./MessagesTimeline";
import { ComposerSurface } from "./ComposerSurface";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { TraitsPicker } from "./TraitsPicker";
import { ComposerFooterModeControls } from "./ComposerFooterModeControls";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";

export interface SideChatPanelProps {
  threadRef: ScopedThreadRef;
  parentTitle: string;
  branch: string | null;
  providerStatuses: ReadonlyArray<ServerProvider>;
  settings: UnifiedSettings;
  keybindings: ResolvedKeybindingsConfig;
  resolvedTheme: "light" | "dark";
  visible: boolean;
  opening: boolean;
  onStart: () => void;
  onSideChatId?: (sideChatId: string) => void;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onFileOpen: (attachment: ChatFileAttachment) => void;
}

// Only the visible surface subscribes. Keeping the editor mounted separately
// preserves drafts while Codex owns the hidden conversation's unload lifetime.
function SideChatSubscription({
  threadRef,
  onSnapshot,
  onError,
}: {
  threadRef: ScopedThreadRef;
  onSnapshot: (snapshot: SideChatSnapshot | null) => void;
  onError: (error: string | null) => void;
}) {
  const result = useAtomValue(
    sideChatEnvironment.state({
      environmentId: threadRef.environmentId,
      input: { parentThreadId: threadRef.threadId },
    }),
  );
  useEffect(() => {
    if (AsyncResult.isSuccess(result)) {
      onSnapshot(result.value);
      onError(null);
    } else if (AsyncResult.isFailure(result)) {
      onError(Cause.pretty(result.cause));
    }
  }, [result, onSnapshot, onError]);
  return null;
}

const EMPTY_CONTEXT_RECORDS = new Map<string, never>();

export function SideChatPanel(props: SideChatPanelProps) {
  const [snapshot, setSnapshot] = useState<SideChatSnapshot | null>(null);
  const [subscriptionError, setSubscriptionError] = useState<string | null>(null);
  const { onSideChatId } = props;
  const onSnapshot = useCallback(
    (next: SideChatSnapshot | null) => {
      setSnapshot((previous) => next ?? (previous ? { ...previous, status: "closed" } : null));
      if (next) onSideChatId?.(next.sideChatId);
    },
    [onSideChatId],
  );
  return (
    <SideChatFocusContext value={true}>
      <section
        data-side-chat="true"
        aria-label="Side chat"
        className="flex h-full min-h-0 flex-col outline-none"
        tabIndex={-1}
        onPointerDown={(event) => {
          if (
            !(event.target instanceof HTMLElement) ||
            event.target.closest('button,a,input,textarea,[contenteditable], [tabindex="0"]')
          )
            return;
          const target =
            event.currentTarget.querySelector<HTMLElement>("[data-side-chat-keyboard-scope]") ??
            event.currentTarget;
          target.focus({ preventScroll: true });
        }}
      >
        {props.visible && (
          <SideChatSubscription
            threadRef={props.threadRef}
            onSnapshot={onSnapshot}
            onError={setSubscriptionError}
          />
        )}
        <div className="flex shrink-0 items-center gap-2 border-b border-border/50 px-4 py-2.5">
          <MessageSquareIcon className="size-3.5 text-muted-foreground" />
          <span className="text-xs font-medium">Side chat</span>
          <Tooltip>
            <TooltipTrigger
              render={<span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" />}
            >
              From {props.parentTitle}
            </TooltipTrigger>
            <TooltipPopup>Context from {props.parentTitle}</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={<span className="text-3xs text-muted-foreground" />}>
              Temporary
            </TooltipTrigger>
            <TooltipPopup className="max-w-64">
              Closing ends this side chat. It is not saved in your thread list.
            </TooltipPopup>
          </Tooltip>
        </div>
        {subscriptionError && (
          <p role="alert" className="px-4 py-2 text-xs text-destructive-foreground">
            {subscriptionError}
          </p>
        )}
        {snapshot ? (
          <SideChatConversation
            key={snapshot.sideChatId}
            {...props}
            snapshot={snapshot}
            connectionError={subscriptionError !== null}
          />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
            {props.opening ? (
              <>
                <Spinner />
                <p className="text-sm text-muted-foreground">Starting side chat…</p>
              </>
            ) : (
              <>
                <MessageSquareIcon className="size-6 text-muted-foreground/60" />
                <p className="text-sm font-medium">A question on the side</p>
                <p className="max-w-72 text-xs leading-relaxed text-muted-foreground">
                  Explore a question with this conversation’s context. Your main chat continues
                  independently.
                </p>
                <Button size="sm" variant="outline" onClick={props.onStart}>
                  Start side chat
                </Button>
              </>
            )}
          </div>
        )}
      </section>
    </SideChatFocusContext>
  );
}

function SideChatConversation({
  snapshot,
  connectionError,
  ...props
}: SideChatPanelProps & { snapshot: SideChatSnapshot; connectionError: boolean }) {
  const send = useAtomCommand(sideChatEnvironment.send);
  const interrupt = useAtomCommand(sideChatEnvironment.interrupt);
  const respondApproval = useAtomCommand(sideChatEnvironment.respondApproval);
  const respondUserInput = useAtomCommand(sideChatEnvironment.respondUserInput);
  const [selection, setSelection] = useState<ModelSelection>(snapshot.modelSelection);
  const [interactionMode, setInteractionMode] = useState(snapshot.interactionMode);
  const [runtimeMode, setRuntimeMode] = useState(snapshot.runtimeMode);
  const [draft, setDraft] = useState("");
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [responding, setResponding] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useComposerMenuState(!props.visible);
  const [error, setError] = useState<string | null>(null);
  const [liveFollow, setLiveFollow] = useState(true);
  const editorRef = useRef<ComposerPromptEditorHandle | null>(null);
  const listRef = useRef<LegendListRef | null>(null);
  const target = { parentThreadId: props.threadRef.threadId, sideChatId: snapshot.sideChatId };
  const environmentId = props.threadRef.environmentId;
  const closed = snapshot.status === "closed";
  const running = snapshot.status === "running";
  const entries = useMemo(
    () =>
      deriveTimelineEntries(
        snapshot.messages,
        snapshot.proposedPlans,
        deriveWorkLogEntries(snapshot.activities),
      ),
    [snapshot.messages, snapshot.proposedPlans, snapshot.activities],
  );
  const pending = useMemo(() => {
    const requests = derivePendingRequests(snapshot.activities);
    const activeIds = new Set<string>(
      snapshot.pendingRequests.flatMap((event) => (event.requestId ? [event.requestId] : [])),
    );
    return {
      approvals: requests.approvals.filter((request) => activeIds.has(request.requestId)),
      userInputs: requests.userInputs.filter((request) => activeIds.has(request.requestId)),
    };
  }, [snapshot.activities, snapshot.pendingRequests]);
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
  const instances = useMemo(
    () =>
      deriveProviderInstanceEntries(props.providerStatuses).filter(
        (entry) => entry.instanceId === snapshot.modelSelection.instanceId,
      ),
    [props.providerStatuses, snapshot.modelSelection.instanceId],
  );
  const models = instances[0]?.models ?? [];
  const modelOptionsByInstance = useMemo(
    () =>
      new Map(
        instances.map((entry) => [
          entry.instanceId,
          getAppModelOptionsForInstance(props.settings, entry, selection.model),
        ]),
      ),
    [instances, props.settings, selection.model],
  );

  const handleInterrupt = () => {
    void interrupt({ environmentId, input: target });
  };
  const advanceQuestion = async () => {
    if (!question || !progress?.canAdvance || responding) return;
    if (!progress.isLastQuestion) {
      setAnswerState({ requestId: question.requestId, answers, index: questionIndex + 1 });
      return;
    }
    const resolvedAnswers = buildPendingUserInputAnswers(question.questions, answers);
    if (!resolvedAnswers) return;
    setResponding(true);
    await respondUserInput({
      environmentId,
      input: { ...target, requestId: question.requestId, answers: resolvedAnswers },
    });
    setResponding(false);
  };
  const submit = async () => {
    if (question) {
      await advanceQuestion();
      return;
    }
    if (busy || running || closed || connectionError || !draft.trim() || approval) return;
    const sentDraft = draft;
    setBusy(true);
    setError(null);
    const result = await send({
      environmentId,
      input: {
        ...target,
        input: sentDraft,
        modelSelection: selection,
        interactionMode,
        runtimeMode,
      },
    });
    setBusy(false);
    if (AsyncResult.isSuccess(result)) {
      setDraft((current) => (current === sentDraft ? "" : current));
      setLiveFollow(true);
    } else if (AsyncResult.isFailure(result)) setError(Cause.pretty(result.cause));
  };
  const prompt = progress ? progress.customAnswer : draft;
  const updatePrompt = (value: string) => {
    if (question && progress?.activeQuestion) {
      const id = progress.activeQuestion.id;
      setAnswerState({
        requestId: question.requestId,
        index: questionIndex,
        answers: { ...answers, [id]: setPendingUserInputCustomAnswer(answers[id], value) },
      });
    } else setDraft(value);
    setCursor(value.length);
  };

  return (
    <div
      className="flex min-h-0 flex-1 flex-col outline-none"
      data-side-chat-keyboard-scope
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.defaultPrevented || event.nativeEvent.isComposing || !props.visible) return;
        // A dialog owns Escape while it is open, even if its focus trap is
        // still settling or an image viewer was opened from this timeline.
        if (
          document.querySelector(
            '[data-slot="alert-dialog-popup"][data-open], [data-slot="dialog-popup"][data-open], [data-slot="command-dialog-popup"][data-open], [data-slot="sheet-popup"][data-open]',
          )
        )
          return;
        const command = resolveShortcutCommand(event.nativeEvent, props.keybindings);
        if (command === "modelPicker.toggle" && !closed) {
          event.preventDefault();
          event.stopPropagation();
          setModelPickerOpen((open) => !open);
        }
        if (command === "thread.stop" && running) {
          event.preventDefault();
          event.stopPropagation();
          handleInterrupt();
        }
      }}
    >
      <div className="relative min-h-0 flex-1">
        {entries.length === 0 ? (
          <div className="flex h-full items-center justify-center px-8 text-center text-xs leading-relaxed text-muted-foreground">
            Ask a question about the conversation so far.
          </div>
        ) : (
          <MessagesTimeline
            isWorking={running}
            activeTurnStartedAt={snapshot.latestTurn?.startedAt ?? null}
            listRef={listRef}
            timelineEntries={entries}
            latestTurn={snapshot.latestTurn}
            runningTurnId={running ? (snapshot.latestTurn?.turnId ?? null) : null}
            turnDiffSummaries={[]}
            routeThreadKey={`side:${snapshot.sideChatId}`}
            onOpenTurnDiff={() => {}}
            supportsConversationRollback={false}
            onRevertToTurnCount={() => {}}
            isRevertingCheckpoint={false}
            onImageExpand={props.onImageExpand}
            onFileOpen={props.onFileOpen}
            activeThreadEnvironmentId={environmentId}
            markdownCwd={snapshot.cwd}
            resolvedTheme={props.resolvedTheme}
            timestampFormat={props.settings.timestampFormat}
            workspaceRoot={snapshot.cwd}
            anchorMessageId={null}
            onAnchorReady={() => {}}
            contentInsetEndAdjustment={0}
            liveFollowEnabled={liveFollow}
            onIsAtEndChange={setLiveFollow}
            onManualNavigation={() => setLiveFollow(false)}
          />
        )}
      </div>
      {closed ? (
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border/50 p-4">
          <p className="text-xs text-muted-foreground">This side chat has ended.</p>
          <Button size="sm" variant="outline" disabled={props.opening} onClick={props.onStart}>
            Start new side chat
          </Button>
        </div>
      ) : (
        <form
          className="shrink-0 p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {(error || snapshot.error) && (
            <p role="alert" className="mb-2 text-xs text-destructive-foreground">
              {error || snapshot.error}
            </p>
          )}
          {approval && (
            <div className="mb-2 space-y-2 rounded-lg border border-border p-2">
              <ComposerPendingApprovalPanel
                approval={approval}
                pendingCount={pending.approvals.length}
              />
              <div className="flex flex-wrap justify-end gap-1">
                <ComposerPendingApprovalActions
                  requestId={approval.requestId}
                  options={approval.options}
                  isResponding={responding}
                  onRespondToApproval={async (requestId, decision) => {
                    setResponding(true);
                    const result = await respondApproval({
                      environmentId,
                      input: { ...target, requestId, decision },
                    });
                    setResponding(false);
                    return result;
                  }}
                />
              </div>
            </div>
          )}
          <ComposerPendingUserInputPanel
            pendingUserInputs={pending.userInputs}
            respondingRequestIds={responding && question ? [question.requestId] : []}
            answers={answers}
            questionIndex={questionIndex}
            keyboardScope="side-chat"
            keyboardEnabled={props.visible}
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
            onDismiss={(requestId) => {
              void respondUserInput({
                environmentId,
                input: { ...target, requestId, answers: {} },
              });
            }}
          />
          <ComposerSurface.Shell>
            <ComposerSurface.Host>
              <ComposerSurface.Main>
                <ComposerPromptEditor
                  value={prompt}
                  cursor={cursor}
                  contextRecords={EMPTY_CONTEXT_RECORDS}
                  skills={[]}
                  disabled={
                    busy ||
                    connectionError ||
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
                  onPaste={() => {}}
                  editorRef={editorRef}
                />
                <div className="flex flex-wrap items-center gap-1 px-2 pb-2">
                  <ProviderModelPicker
                    activeInstanceId={selection.instanceId}
                    model={selection.model}
                    lockedProvider={ProviderDriverKind.make("codex")}
                    instanceEntries={instances}
                    modelOptionsByInstance={modelOptionsByInstance}
                    size="xs"
                    isComposerOwned
                    open={modelPickerOpen}
                    onOpenChange={setModelPickerOpen}
                    onInstanceModelChange={(_, model) =>
                      setSelection((current) => ({ ...current, model }))
                    }
                  />
                  <TraitsPicker
                    provider={ProviderDriverKind.make("codex")}
                    instanceId={selection.instanceId}
                    models={models}
                    model={selection.model}
                    prompt={prompt}
                    onPromptChange={updatePrompt}
                    modelOptions={selection.options}
                    planModeEnabled={interactionMode === "plan"}
                    size="xs"
                    isComposerOwned
                    hidden={!props.visible}
                    onModelOptionsChange={(options) =>
                      setSelection((current) => ({
                        instanceId: current.instanceId,
                        model: current.model,
                        ...(options ? { options } : {}),
                      }))
                    }
                  />
                  <ComposerFooterModeControls
                    size="xs"
                    showInteractionModeToggle
                    interactionMode={interactionMode}
                    runtimeMode={runtimeMode}
                    hidden={!props.visible}
                    onToggleInteractionMode={() =>
                      setInteractionMode((mode) => (mode === "plan" ? "default" : "plan"))
                    }
                    onRuntimeModeChange={setRuntimeMode}
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
                              isResponding: responding,
                              isComplete: progress.isComplete,
                            }
                          : null
                      }
                      isRunning={running}
                      showPlanFollowUpPrompt={false}
                      promptHasText={!!prompt.trim()}
                      isSendBusy={busy}
                      sendDisabledReason={
                        connectionError
                          ? "Reconnecting to side chat"
                          : approval
                            ? "Respond to the approval first"
                            : null
                      }
                      isConnecting={false}
                      isEnvironmentUnavailable={connectionError}
                      isPreparingWorktree={false}
                      hasSendableContent={!!prompt.trim()}
                      onPreviousPendingQuestion={() => {
                        if (question)
                          setAnswerState({
                            requestId: question.requestId,
                            answers,
                            index: Math.max(0, questionIndex - 1),
                          });
                      }}
                      onInterrupt={handleInterrupt}
                      onImplementPlanInNewThread={() => {}}
                    />
                  </div>
                </div>
              </ComposerSurface.Main>
            </ComposerSurface.Host>
          </ComposerSurface.Shell>
          <Tooltip>
            <TooltipTrigger
              render={
                <div className="mt-2 flex min-w-0 items-center gap-1.5 px-2 text-3xs text-muted-foreground" />
              }
            >
              <GitBranchIcon className="size-3 shrink-0" />
              <span className="truncate">{props.branch ?? "Detached HEAD"}</span>
              <span className="ml-auto truncate">
                {snapshot.cwd
                  .replace(/[\\/]+$/, "")
                  .split(/[\\/]/)
                  .at(-1)}
              </span>
            </TooltipTrigger>
            <TooltipPopup className="max-w-72">
              Inherited workspace: {snapshot.cwd}. Workspace and branch cannot be changed in a side
              chat.
            </TooltipPopup>
          </Tooltip>
        </form>
      )}
    </div>
  );
}

export default SideChatPanel;
