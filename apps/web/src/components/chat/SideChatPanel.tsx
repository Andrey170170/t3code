import { useAtomValue } from "@effect/atom-react";
import type { LegendListRef } from "@legendapp/list/react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  derivePendingThreadRequests,
  type PendingThreadRequests,
} from "@t3tools/client-runtime/state/thread-requests";
import {
  ProviderDriverKind,
  ThreadId,
  type ChatFileAttachment,
  type EnvironmentId,
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
import { AsyncResult } from "effect/reactivity";
import { MessagesSquare } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

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
import { closeSideChat, sideChatEnvironment } from "../../state/sideChat";
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
import { getComposerPromptLengthValidationMessage } from "./composerSubmission";
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
const EMPTY_ARRAY: readonly never[] = [];
const EMPTY_PENDING: PendingThreadRequests = { approvals: [], userInputs: [] };
const noop = () => {};

/**
 * Side chat opens by parent: in flight, or failed while no starter was mounted.
 * A remounted starter joins the open instead of forking twice, and still sees its failure.
 * Resolves to an error message, or null once the side chat started.
 */
const pendingOpens = new Map<string, Promise<string | null>>();

/** Composer state that outlives the panel while another tab is selected. */
interface SideChatDraft {
  readonly prompt: string;
  readonly modelSelection?: ModelSelection;
  readonly interactionMode?: ProviderInteractionMode;
  readonly runtimeMode?: RuntimeMode;
}
const draftsBySideChatId = new Map<string, SideChatDraft>();
const EMPTY_DRAFT: SideChatDraft = { prompt: "" };

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
          // The nearest focus scope is the conversation, whose key handler owns side chat shortcuts.
          if (
            !(event.target instanceof HTMLElement) ||
            event.target.closest('button,a,input,textarea,[contenteditable],[tabindex="0"]')
          )
            return;
          const scope = event.target.closest<HTMLElement>('[tabindex="-1"]') ?? event.currentTarget;
          scope.focus({ preventScroll: true });
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

function SideChatStarter({ threadRef }: { threadRef: ScopedThreadRef }) {
  const [attempt, setAttempt] = useState(0);
  // Each attempt mounts fresh, so a retry starts a new open.
  return (
    <SideChatOpening
      key={attempt}
      threadRef={threadRef}
      onRetry={() => setAttempt((current) => current + 1)}
    />
  );
}

/** Asks the server for the parent's side chat and records its id on the tab. */
function SideChatOpening({
  threadRef,
  onRetry,
}: {
  threadRef: ScopedThreadRef;
  onRetry: () => void;
}) {
  const open = useAtomCommand(sideChatEnvironment.open, { reportFailure: false });
  const [error, setError] = useState<string | null>(null);
  const { environmentId, threadId } = threadRef;
  useEffect(() => {
    const key = scopedThreadKey({ environmentId, threadId });
    let pending = pendingOpens.get(key);
    if (!pending) {
      pending = open({ environmentId, input: { parentThreadId: threadId } }).then((result) => {
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            return errorMessage(squashAtomCommandFailure(result), "Could not start a side chat.");
          }
          pendingOpens.delete(key);
          return null;
        }
        pendingOpens.delete(key);
        const { sideChatId } = result.value;
        // The tab closed while the fork was starting; do not leave an invisible conversation.
        if (!useRightPanelStore.getState().setSideChatId({ environmentId, threadId }, sideChatId)) {
          closeSideChat(environmentId, { parentThreadId: threadId, sideChatId });
        }
        return null;
      });
      pendingOpens.set(key, pending);
    }
    const joined = pending;
    let active = true;
    void joined.then((message) => {
      if (!active || message === null) return;
      // Seen here, so the next mount starts over instead of replaying this failure.
      if (pendingOpens.get(key) === joined) pendingOpens.delete(key);
      setError(message);
    });
    return () => {
      active = false;
    };
  }, [environmentId, open, threadId]);
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      {error !== null ? (
        <>
          <p className="max-w-72 text-xs leading-relaxed text-muted-foreground">{error}</p>
          <Button size="sm" variant="outline" onClick={onRetry}>
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

function SideChatEnded({
  threadRef,
  reason = null,
}: {
  threadRef: ScopedThreadRef;
  /** Why it ended, when it failed. */
  reason?: string | null;
}) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border/50 p-4">
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-xs text-muted-foreground">This side chat has ended.</p>
        {reason ? (
          <p role="alert" className="text-xs text-destructive-foreground">
            {reason}
          </p>
        ) : null}
      </div>
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
  // A failed one cannot continue either; starting a new side chat replaces it.
  const failure = AsyncResult.isFailure(result) ? squashAtomCommandFailure(result) : null;
  const ended =
    snapshot?.status === "closed" ||
    snapshot?.status === "error" ||
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
  const interrupt = useAtomCommand(sideChatEnvironment.interrupt, { reportFailure: false });
  const environmentId = props.threadRef.environmentId;
  const routeThreadKey = scopedThreadKey(props.threadRef);
  const { parentThreadId, sideChatId } = snapshot;

  useEffect(() => {
    if (ended) draftsBySideChatId.delete(sideChatId);
  }, [ended, sideChatId]);

  const [error, setError] = useState<string | null>(null);
  const [liveFollow, setLiveFollow] = useState(true);
  const [modelPickerOpen, setModelPickerOpen] = useComposerMenuState(false);
  const listRef = useRef<LegendListRef | null>(null);
  const followLive = useCallback(() => setLiveFollow(true), []);
  const stopFollowing = useCallback(() => setLiveFollow(false), []);

  const starting = snapshot.status === "starting";
  const running = !ended && snapshot.status === "running";
  const composerLocked = ended || starting;

  const timelineEntries = useMemo(() => {
    const visibleTurnItems = snapshot.turnItems.map(
      (item, position): OrchestrationV2ProjectedTurnItem => ({
        position,
        visibility: "local",
        sourceThreadId: sideChatId,
        sourceItemId: item.id,
        item,
      }),
    );
    return deriveTimelineEntriesFromVisibleTurnItems({ visibleTurnItems, optimisticMessages: [] });
  }, [sideChatId, snapshot.turnItems]);
  const activeTurnStartedAt = useMemo(() => {
    if (!running) return null;
    const latestUserMessage = snapshot.turnItems.findLast((item) => item.type === "user_message");
    if (!latestUserMessage) return null;
    return DateTime.formatIso(latestUserMessage.startedAt ?? latestUserMessage.updatedAt);
  }, [running, snapshot.turnItems]);

  // Without a pending request the result is constant, so streaming frames keep the composer still.
  const pending = useMemo(
    () =>
      snapshot.runtimeRequests.some((request) => request.status === "pending")
        ? derivePendingThreadRequests({
            runtimeRequests: snapshot.runtimeRequests,
            turnItems: snapshot.turnItems,
          })
        : EMPTY_PENDING,
    [snapshot.runtimeRequests, snapshot.turnItems],
  );

  const handleInterrupt = useCallback(() => {
    void interrupt({ environmentId, input: { parentThreadId, sideChatId } }).then((result) => {
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        setError(errorMessage(squashAtomCommandFailure(result), "Could not stop the side chat."));
      }
    });
  }, [environmentId, interrupt, parentThreadId, sideChatId]);
  const visibleError = error ?? failureMessage ?? snapshot.error ?? null;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col outline-none"
      // Focus scope for clicks on non-focusable content; see SideChatPanel.
      tabIndex={-1}
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
              turnDiffSummaries={EMPTY_ARRAY}
              // The parent's key keeps thread-scoped lookups (links, PRs) on the parent;
              // the display key keeps scroll memory separate from the main timeline.
              routeThreadKey={routeThreadKey}
              displayThreadKey={`side-chat:${sideChatId}`}
              onOpenTurnDiff={noop}
              onOpenThread={noop}
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
              runs={EMPTY_ARRAY}
              anchorMessageId={null}
              onAnchorReady={noop}
              onAnchorSizeChanged={noop}
              contentInsetEndAdjustment={0}
              liveFollowEnabled={liveFollow}
              onIsAtEndChange={setLiveFollow}
              onManualNavigation={stopFollowing}
            />
          </ChatCanvasContext>
        )}
      </div>
      {ended ? (
        <SideChatEnded threadRef={props.threadRef} reason={visibleError} />
      ) : (
        <SideChatComposer
          environmentId={environmentId}
          parentThreadId={parentThreadId}
          sideChatId={sideChatId}
          serverModelSelection={snapshot.modelSelection}
          serverInteractionMode={snapshot.interactionMode}
          serverRuntimeMode={snapshot.runtimeMode}
          starting={starting}
          running={running}
          pending={pending}
          visibleError={visibleError}
          setError={setError}
          modelPickerOpen={modelPickerOpen}
          setModelPickerOpen={setModelPickerOpen}
          onInterrupt={handleInterrupt}
          onSent={followLive}
          providerStatuses={props.providerStatuses}
          settings={props.settings}
          keybindings={props.keybindings}
        />
      )}
    </div>
  );
}

interface SideChatComposerProps {
  environmentId: EnvironmentId;
  parentThreadId: ThreadId;
  sideChatId: ThreadId;
  /** The selection the server last ran with; local draft overrides win until sent. */
  serverModelSelection: ModelSelection;
  serverInteractionMode: ProviderInteractionMode;
  serverRuntimeMode: RuntimeMode;
  starting: boolean;
  running: boolean;
  pending: PendingThreadRequests;
  visibleError: string | null;
  setError: Dispatch<SetStateAction<string | null>>;
  modelPickerOpen: boolean;
  setModelPickerOpen: Dispatch<SetStateAction<boolean>>;
  onInterrupt: () => void;
  onSent: () => void;
  providerStatuses: ReadonlyArray<ServerProvider>;
  settings: UnifiedSettings;
  keybindings: ResolvedKeybindingsConfig;
}

/** Owns the draft, so keystrokes do not re-render the timeline and streaming does not re-render this. */
const SideChatComposer = memo(function SideChatComposer({
  environmentId,
  parentThreadId,
  sideChatId,
  serverModelSelection,
  serverInteractionMode,
  serverRuntimeMode,
  starting,
  running,
  pending,
  visibleError,
  setError,
  modelPickerOpen,
  setModelPickerOpen,
  onInterrupt,
  onSent,
  ...props
}: SideChatComposerProps) {
  const send = useAtomCommand(sideChatEnvironment.send, { reportFailure: false });
  const respond = useAtomCommand(sideChatEnvironment.respond, { reportFailure: false });
  const target = { parentThreadId, sideChatId };

  const [draft, setDraftState] = useState(() => draftsBySideChatId.get(sideChatId) ?? EMPTY_DRAFT);
  // The module map is written directly, not from a state updater, so a send that
  // settles after this unmounts still clears the stored prompt.
  const updateDraft = (update: (current: SideChatDraft) => SideChatDraft) => {
    const next = update(draftsBySideChatId.get(sideChatId) ?? EMPTY_DRAFT);
    draftsBySideChatId.set(sideChatId, next);
    setDraftState(next);
  };

  const modelSelection = draft.modelSelection ?? serverModelSelection;
  const runtimeMode = draft.runtimeMode ?? serverRuntimeMode;
  const [cursor, setCursor] = useState(draft.prompt.length);
  const [sending, setSending] = useState(false);
  const [respondingRequestIds, setRespondingRequestIds] = useState<RuntimeRequestId[]>([]);
  const editorRef = useRef<ComposerPromptEditorHandle | null>(null);

  const providerStatus =
    props.providerStatuses.find((status) => status.instanceId === modelSelection.instanceId) ??
    null;
  const { enabled: interactionModeEnabled, interactionMode } = resolveComposerInteractionMode({
    planModeEnabled: props.settings.planModeEnabled,
    provider: providerStatus,
    interactionMode: draft.interactionMode ?? serverInteractionMode,
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
    if (sending || running || starting || approval || !prompt) return;
    const lengthError = getComposerPromptLengthValidationMessage(prompt);
    if (lengthError) {
      setError(lengthError);
      return;
    }
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
      updateDraft((current) => (current.prompt === draft.prompt ? EMPTY_DRAFT : current));
      setCursor(0);
      onSent();
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

  return (
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
        onDismiss={(requestId) => void respondToRequest(requestId, { decision: "cancel" })}
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
              skills={EMPTY_ARRAY}
              disabled={
                starting ||
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
                disabled={starting}
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
                models={providerStatus?.models ?? EMPTY_ARRAY}
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
                  onInterrupt={onInterrupt}
                  onImplementPlanInNewThread={noop}
                />
              </div>
            </div>
          </ComposerSurface.Main>
        </ComposerSurface.Host>
      </ComposerSurface.Shell>
    </form>
  );
});

export default SideChatPanel;
