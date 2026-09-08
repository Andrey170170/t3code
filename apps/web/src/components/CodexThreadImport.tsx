import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  canImportCodexConversation,
  codexImportKey,
  codexImportProjectCwd,
  codexImportWorktree,
  codexProjectSelectionState,
  resolveCodexImportCheckout,
  runCodexImportBatch,
  updateCodexImportSelection,
  type CodexImportCandidate,
} from "@t3tools/client-runtime/state/codexImportSelection";
import type {
  CodexConversationOrigin,
  CodexThreadsListInput,
  CodexThreadsListResult,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ArrowLeftIcon,
  BotIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  FolderOpenIcon,
  GitBranchIcon,
  ImportIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  UserRoundIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useProjects } from "../state/entities";
import { cn, newProjectId } from "../lib/utils";
import { codexThreads } from "../state/codexThreads";
import { projectEnvironment } from "../state/projects";
import { useDebouncedValue } from "../state/queries";
import { serverEnvironment, EMPTY_SERVER_PROVIDERS } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { ProjectFavicon } from "./ProjectFavicon";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from "./ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./ui/input-group";
import { Kbd } from "./ui/kbd";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "./ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Skeleton } from "./ui/skeleton";
import { Spinner } from "./ui/spinner";
import { toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

type Props = {
  environmentId: EnvironmentId;
  projectId?: ProjectId;
  workspaceRoot?: string;
  label?: string;
};
type Project = CodexThreadsListResult["projects"][number];
type Selection = { providerInstanceId: ProviderInstanceId; thread: CodexImportCandidate };
type ImportResult = Selection & {
  key: string;
  status: "pending" | "importing" | "success" | "failed";
  threadId?: ThreadId;
  error?: string | undefined;
};
const ORIGINS = ["human", "agent", "mixed", "unknown"] as const;
const ORIGIN_LABELS = {
  human: "Started by you",
  agent: "Started by an agent",
  mixed: "Started by an agent, continued by you",
  unknown: "Origin unknown",
};
const EMPTY_RESULT: CodexThreadsListResult = {
  threads: [],
  projects: [],
  nextCursor: null,
  totalCount: 0,
  catalogComplete: false,
  messageSearchSupported: null,
};

/** The owner stays mounted when the popup closes so a batch can finish and report its result. */
export function CodexThreadImportButton(
  props: Omit<Props, "environmentId"> & { environmentId: EnvironmentId | null },
) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<Props | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={!props.environmentId}
        onClick={() => {
          if (!busy && props.environmentId)
            setScope({ ...props, environmentId: props.environmentId });
          setOpen(true);
        }}
      >
        <ImportIcon className="size-3.5" />
        {props.label ?? "Import conversations"}
      </Button>
      {scope ? (
        <CodexThreadImportDialog
          key={`${scope.environmentId}:${scope.projectId ?? "all"}`}
          {...scope}
          open={open}
          onOpenChange={setOpen}
          onImportingChange={setBusy}
        />
      ) : null}
    </>
  );
}

export function CodexThreadImportDialog({
  environmentId,
  projectId,
  workspaceRoot,
  open,
  onOpenChange,
  onImportingChange,
}: Props & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImportingChange?: (busy: boolean) => void;
}) {
  const providers = (
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS
  ).filter((provider) => provider.driver === "codex" && provider.enabled);
  const knownProjects = useProjects();
  const navigate = useNavigate();
  const [selectedProvider, setSelectedProvider] = useState<ProviderInstanceId | null>(null);
  const providerInstanceId = selectedProvider ?? providers[0]?.instanceId;
  const list = useAtomCommand(codexThreads.list, { reportFailure: false });
  const adopt = useAtomCommand(codexThreads.import, { reportFailure: false });
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const [cwd, setCwd] = useState<string | null>(workspaceRoot ?? null);
  const [search, setSearch] = useState("");
  const query = useDebouncedValue(search.trim(), 300);
  const [searchScope, setSearchScope] = useState<"titles" | "messages">("titles");
  const [archived, setArchived] = useState(false);
  const [hideImported, setHideImported] = useState(true);
  const [origin, setOrigin] = useState<CodexConversationOrigin | undefined>();
  const [data, setData] = useState<CodexThreadsListResult>(EMPTY_RESULT);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selection, setSelection] = useState<Map<string, Selection>>(() => new Map());
  const [checkoutChoices, setCheckoutChoices] = useState(() => new Map<string, string>());
  const [selectingProject, setSelectingProject] = useState<string | null>(null);
  const [results, setResults] = useState<ImportResult[] | null>(null);
  const [importing, setImporting] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const generation = useRef(0);
  const cache = useRef(new Map<string, CodexThreadsListResult>());
  const [catalogProjects, setCatalogProjects] = useState(() => new Map<string, Project>());
  const [matchingKeys, setMatchingKeys] = useState(() => new Map<string, Set<string>>());
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);
  useEffect(
    () => () => {
      openRef.current = false;
    },
    [],
  );
  const searchRef = useRef<HTMLInputElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const latestProjects = useRef(knownProjects);
  useEffect(() => {
    latestProjects.current = knownProjects;
  }, [knownProjects]);
  const input = useMemo(
    (): CodexThreadsListInput | null =>
      providerInstanceId
        ? {
            providerInstanceId,
            archived,
            hideImported,
            searchScope,
            ...(cwd !== null ? { cwd } : {}),
            ...(origin ? { origin } : {}),
            ...(query ? { search: query } : {}),
          }
        : null,
    [providerInstanceId, archived, hideImported, searchScope, cwd, origin, query],
  );
  const queryKey = JSON.stringify(input);
  const filterKey = JSON.stringify([
    providerInstanceId,
    archived,
    hideImported,
    searchScope,
    origin,
    query,
  ]);
  const pendingSearch = query !== search.trim();
  const currentProject =
    data.projects.find((project) => project.cwd === cwd) ??
    (cwd && data.projects.length === 1 ? data.projects[0] : undefined) ??
    (cwd ? catalogProjects.get(cwd) : undefined);
  const projectTitle =
    currentProject?.title ?? cwd?.split(/[\\/]/).findLast(Boolean) ?? "Conversations";

  const load = useCallback(
    async (cursor?: string, refresh = false) => {
      if (!input) return;
      const request = ++generation.current;
      setLoading(true);
      setError("");
      const response = await list({
        environmentId,
        input: { ...input, ...(cursor ? { cursor } : {}), ...(refresh ? { refresh: true } : {}) },
      });
      if (request !== generation.current) return;
      setLoading(false);
      if (response._tag !== "Success") {
        setError(
          response._tag === "Failure"
            ? String(squashAtomCommandFailure(response))
            : "The request was interrupted. Try again.",
        );
        return;
      }
      const result = response.value;
      setSelection((previous) => {
        const next = new Map(previous);
        for (const thread of result.threads) {
          const key = codexImportKey(input.providerInstanceId, thread);
          if (!next.has(key)) continue;
          if (canImportCodexConversation(thread))
            next.set(key, { providerInstanceId: input.providerInstanceId, thread });
          else next.delete(key);
        }
        return next;
      });
      setCatalogProjects((previous) => {
        const next = new Map(previous);
        for (const project of result.projects) next.set(project.cwd, project);
        return next;
      });
      setMatchingKeys((previous) => {
        const next = new Map(previous);
        for (const thread of result.threads) {
          const key = JSON.stringify([filterKey, codexImportProjectCwd(thread)]);
          const keys = new Set(next.get(key));
          keys.add(thread.sourceIdentity);
          next.set(key, keys);
        }
        return next;
      });
      const previous = cache.current.get(queryKey);
      const next =
        cursor && previous
          ? {
              ...result,
              threads: [
                ...new Map(
                  [...previous.threads, ...result.threads].map((thread) => [
                    thread.sourceIdentity,
                    thread,
                  ]),
                ).values(),
              ],
            }
          : result;
      if (cache.current.size >= 20) cache.current.delete(cache.current.keys().next().value!);
      cache.current.set(queryKey, next);
      setData(next);
    },
    [environmentId, filterKey, input, list, queryKey],
  );

  const showingResults = results !== null;
  useEffect(() => {
    generation.current++;
    if (!open || showingResults) return;
    setHighlight(0);
    const cached = cache.current.get(queryKey);
    setData(cached ?? EMPTY_RESULT);
    if (cached) {
      setLoading(false);
      setError("");
    } else void load();
    return () => {
      generation.current++;
    };
  }, [open, queryKey, load, showingResults]);
  useEffect(() => {
    if (open && !showingResults) searchRef.current?.focus();
  }, [open, showingResults]);
  useEffect(() => {
    if (!cwd || !data.nextCursor || loading || pendingSearch || error) return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) void load(data.nextCursor!);
      },
      { rootMargin: "80px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [cwd, data.nextCursor, loading, pendingSearch, error, load]);

  const visibleThreads = hideImported
    ? data.threads.filter(canImportCodexConversation)
    : data.threads;
  const visibleProjects = hideImported
    ? data.projects.filter((project) => project.importableCount > 0)
    : data.projects;
  const selectedKeys = new Set(selection.keys());
  function matchesCurrentFilter(item: Selection) {
    if (
      item.providerInstanceId !== providerInstanceId ||
      item.thread.archived !== archived ||
      (origin && item.thread.origin !== origin)
    )
      return false;
    if (!query) return true;
    // Message matches are authoritative only when returned by this query, including cached pages.
    return (
      matchingKeys
        .get(JSON.stringify([filterKey, codexImportProjectCwd(item.thread)]))
        ?.has(item.thread.sourceIdentity) ?? false
    );
  }
  function projectSelection(project: Project) {
    const count = [...selection.values()].filter(
      (item) => codexImportProjectCwd(item.thread) === project.cwd && matchesCurrentFilter(item),
    ).length;
    return codexProjectSelectionState(count, project.importableCount, data.catalogComplete);
  }
  function toggleThread(thread: CodexImportCandidate) {
    if (!providerInstanceId || !canImportCodexConversation(thread)) return;
    const key = codexImportKey(providerInstanceId, thread);
    setSelection((previous) =>
      updateCodexImportSelection(
        previous,
        [[key, { providerInstanceId, thread }]],
        !previous.has(key),
      ),
    );
  }
  async function toggleProject(project: Project) {
    if (!input || selectingProject) return;
    const clear = projectSelection(project).checked;
    const request = generation.current;
    setSelectingProject(project.cwd);
    setError("");
    const candidates: Array<readonly [string, Selection]> = [];
    let cursor: string | undefined;
    try {
      // Selecting a project resolves every matching metadata page before changing selection.
      do {
        const response = await list({
          environmentId,
          input: { ...input, cwd: project.cwd, ...(cursor ? { cursor } : {}) },
        });
        if (request !== generation.current) return;
        if (response._tag !== "Success")
          throw new Error(
            response._tag === "Failure"
              ? String(squashAtomCommandFailure(response))
              : "Selection was interrupted.",
          );
        setCatalogProjects((previous) => {
          const next = new Map(previous);
          for (const group of response.value.projects) next.set(group.cwd, group);
          return next;
        });
        if (!response.value.catalogComplete)
          throw new Error(
            "This catalog is incomplete. Refresh it or select individual conversations.",
          );
        for (const thread of response.value.threads) {
          if (canImportCodexConversation(thread))
            candidates.push([
              codexImportKey(input.providerInstanceId, thread),
              { providerInstanceId: input.providerInstanceId, thread },
            ]);
        }
        cursor = response.value.nextCursor ?? undefined;
      } while (cursor);
      setMatchingKeys((previous) =>
        new Map(previous).set(
          JSON.stringify([filterKey, project.cwd]),
          new Set(candidates.map(([, item]) => item.thread.sourceIdentity)),
        ),
      );
      setSelection((previous) => updateCodexImportSelection(previous, candidates, !clear));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSelectingProject(null);
    }
  }

  function checkoutResolution(thread: CodexImportCandidate) {
    const projectCwd = codexImportProjectCwd(thread);
    return resolveCodexImportCheckout(
      thread,
      checkoutChoices.get(projectCwd),
      catalogProjects.get(projectCwd)?.checkouts ?? [],
    );
  }
  const unresolvedCheckoutCount = [...selection.values()].filter(
    (item) => checkoutResolution(item.thread).kind === "choose-checkout",
  ).length;
  const missingProjectCounts = new Map<string, number>();
  for (const item of selection.values()) {
    if (!item.thread.worktreeMissing) continue;
    const projectCwd = codexImportProjectCwd(item.thread);
    missingProjectCounts.set(projectCwd, (missingProjectCounts.get(projectCwd) ?? 0) + 1);
  }
  if (cwd !== null) {
    for (const thread of visibleThreads) {
      if (!thread.worktreeMissing || !canImportCodexConversation(thread)) continue;
      const projectCwd = codexImportProjectCwd(thread);
      if (!missingProjectCounts.has(projectCwd)) missingProjectCounts.set(projectCwd, 0);
    }
  }

  async function importSelection(retry?: ImportResult[]) {
    if (importing || selectingProject || (!retry && selection.size === 0)) return;
    const batch =
      retry ??
      [...selection].map(([key, item]): ImportResult => ({ ...item, key, status: "pending" }));
    if (!batch.length) return;
    const needsCheckout = batch.filter(
      (item) => checkoutResolution(item.thread).kind === "choose-checkout",
    ).length;
    if (needsCheckout > 0) {
      setError(
        `${needsCheckout} selected conversations need an existing checkout. Choose one for each project with removed worktrees.`,
      );
      return;
    }
    setImporting(true);
    onImportingChange?.(true);
    setError("");
    setResults((previous) =>
      retry && previous
        ? previous.map((item) =>
            batch.some((candidate) => candidate.key === item.key)
              ? { ...item, status: "pending", error: undefined }
              : item,
          )
        : batch,
    );
    const projectPromises = new Map<string, Promise<ProjectId>>();
    const resolveProject = (item: Selection) => {
      const path = codexImportProjectCwd(item.thread);
      let promise = projectPromises.get(path);
      if (!promise) {
        promise = (async () => {
          const existing = latestProjects.current.find(
            (project) => project.environmentId === environmentId && project.workspaceRoot === path,
          );
          if (existing) return existing.id;
          const catalogId = catalogProjects.get(path)?.existingProjectId;
          if (catalogId) return catalogId;
          if (projectId && workspaceRoot === path) return projectId;
          if (!path) throw new Error("This conversation has no project folder.");
          const id = newProjectId();
          const created = await createProject({
            environmentId,
            input: {
              projectId: id,
              title: path.split(/[\\/]/).findLast(Boolean) ?? path,
              workspaceRoot: path,
              createWorkspaceRootIfMissing: false,
              defaultModelSelection: null,
            },
          });
          if (created._tag !== "Success")
            throw new Error(
              created._tag === "Failure"
                ? String(squashAtomCommandFailure(created))
                : "Project creation was interrupted.",
            );
          return id;
        })();
        projectPromises.set(path, promise);
      }
      return promise;
    };
    let successes = 0;
    let failures = 0;
    await runCodexImportBatch(
      batch,
      async (item) => {
        setResults(
          (previous) =>
            previous?.map((row) =>
              row.key === item.key ? { ...row, status: "importing" } : row,
            ) ?? null,
        );
        const checkout = checkoutResolution(item.thread);
        if (checkout.kind === "choose-checkout")
          throw new Error("Choose an existing checkout for this removed worktree.");
        const targetProjectId = await resolveProject(item);
        const response = await adopt({
          environmentId,
          input: {
            providerInstanceId: item.providerInstanceId,
            nativeThreadId: item.thread.id,
            archived: item.thread.archived,
            projectId: targetProjectId,
            ...(checkout.kind === "chosen-checkout" ? { cwdOverride: checkout.cwdOverride } : {}),
          },
        });
        if (response._tag !== "Success")
          throw new Error(
            response._tag === "Failure"
              ? String(squashAtomCommandFailure(response))
              : "Import was interrupted. Retry this conversation.",
          );
        return response.value;
      },
      (item, settled) => {
        if (settled.ok) {
          successes++;
          setSelection((previous) => {
            const next = new Map(previous);
            next.delete(item.key);
            return next;
          });
          setResults(
            (previous) =>
              previous?.map((row) =>
                row.key === item.key
                  ? {
                      ...row,
                      status: "success",
                      threadId: settled.value.threadId,
                      error: undefined,
                    }
                  : row,
              ) ?? null,
          );
        } else {
          failures++;
          setResults(
            (previous) =>
              previous?.map((row) =>
                row.key === item.key
                  ? {
                      ...row,
                      status: "failed",
                      error:
                        settled.error instanceof Error
                          ? settled.error.message
                          : String(settled.error),
                    }
                  : row,
              ) ?? null,
          );
        }
      },
    );
    cache.current.clear();
    setImporting(false);
    onImportingChange?.(false);
    if (!openRef.current)
      toastManager.add({
        type: failures ? "error" : "success",
        title: `Imported ${successes} of ${batch.length} conversations`,
        ...(failures ? { description: `${failures} failed. Reopen Import to retry.` } : {}),
      });
  }

  const failed = results?.filter((result) => result.status === "failed") ?? [];
  const succeeded = results?.filter((result) => result.status === "success").length ?? 0;
  const completed = (results ?? []).filter(
    (result) => result.status === "success" || result.status === "failed",
  ).length;
  const rowCount = cwd === null ? visibleProjects.length : visibleThreads.length;
  const locked = loading || pendingSearch || selectingProject !== null;
  function openProject(path: string) {
    setCwd(path);
    setHighlight(0);
    searchRef.current?.focus();
  }
  function goBack() {
    if (results && !importing) setResults(null);
    else if (!results) setCwd(null);
  }
  function projectIcon(path: string, title: string) {
    const existing = knownProjects.find(
      (project) => project.environmentId === environmentId && project.workspaceRoot === path,
    );
    return (
      <ProjectFavicon
        project={
          existing ?? {
            environmentId,
            workspaceRoot: path,
            title,
            faviconPath: null,
            projectIcon: null,
          }
        }
        className="size-4"
      />
    );
  }
  const catalogControls =
    !results && providers.length > 0 ? (
      <div className="shrink-0 space-y-2 px-6 pb-2">
        {providers.length > 1 ? (
          <Select
            value={providerInstanceId}
            onValueChange={(value) => {
              if (value) {
                setSelectedProvider(value as ProviderInstanceId);
                setSelection(new Map());
                setCheckoutChoices(new Map());
                setCatalogProjects(new Map());
              }
            }}
          >
            <SelectTrigger size="sm" aria-label="Codex provider">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {providers.map((provider) => (
                <SelectItem key={provider.instanceId} value={provider.instanceId}>
                  {provider.instanceId}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : null}
        <div className="flex min-w-0 items-center gap-2">
          <InputGroup className="w-0 min-w-0 flex-1">
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput
              ref={searchRef}
              size="sm"
              aria-label="Search conversations"
              placeholder={
                searchScope === "messages"
                  ? "Search full messages…"
                  : "Search projects and conversation titles…"
              }
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </InputGroup>
          <Select
            value={searchScope}
            onValueChange={(value) => {
              if (value === "titles" || value === "messages") setSearchScope(value);
            }}
          >
            <SelectTrigger className="w-32 min-w-0 shrink-0" size="sm" aria-label="Search scope">
              <SelectValue>{searchScope === "titles" ? "Titles" : "Full messages"}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="titles">Titles</SelectItem>
              <SelectItem value="messages">Full messages</SelectItem>
            </SelectPopup>
          </Select>
          <Menu>
            <MenuTrigger
              render={<Button size="icon-sm" variant="outline" aria-label="Filter conversations" />}
            >
              <SlidersHorizontalIcon />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuCheckboxItem checked={archived} onCheckedChange={setArchived}>
                Archived
              </MenuCheckboxItem>
              <MenuCheckboxItem checked={hideImported} onCheckedChange={setHideImported}>
                Hide already imported
              </MenuCheckboxItem>
              <MenuSeparator />
              <MenuGroup>
                <MenuGroupLabel>Conversation origin</MenuGroupLabel>
                {ORIGINS.map((value) => (
                  <MenuCheckboxItem
                    key={value}
                    checked={origin === value}
                    onCheckedChange={(checked) => setOrigin(checked ? value : undefined)}
                  >
                    <span className="flex items-center gap-2">
                      <OriginIcon origin={value} />
                      {value === "human"
                        ? "Human"
                        : value === "agent"
                          ? "Agent"
                          : value === "mixed"
                            ? "Mixed"
                            : "Unknown"}
                    </span>
                  </MenuCheckboxItem>
                ))}
              </MenuGroup>
            </MenuPopup>
          </Menu>
        </div>
        <div
          role="status"
          className="flex min-h-9 items-center justify-between gap-2 border-b px-1 text-xs text-muted-foreground"
        >
          <span>
            {selectingProject
              ? "Selecting all matching conversations…"
              : loading || pendingSearch
                ? query
                  ? "Searching…"
                  : "Loading conversations…"
                : `${data.totalCount}${data.catalogComplete ? "" : "+"} ${query ? "matches" : "conversations"}${cwd === null ? ` in ${data.projects.length} projects` : ""}`}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={locked}
            onClick={() => {
              cache.current.clear();
              void load(undefined, true);
            }}
          >
            Refresh
          </Button>
        </div>
      </div>
    ) : null;
  return (
    <Dialog
      open={open}
      onOpenChange={(next, details) => {
        if (!next && details.reason === "escape-key" && cwd !== null && !results) {
          details.cancel();
          goBack();
          return;
        }
        onOpenChange(next);
      }}
    >
      <DialogPopup
        className="h-[min(44rem,calc(100dvh-4rem))] max-w-3xl"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            if (!results) void importSelection();
            return;
          }
          if (
            results ||
            (event.target instanceof HTMLElement &&
              event.target.closest('[data-slot="menu-popup"],[data-slot="select-popup"]'))
          )
            return;
          const typing = event.target instanceof HTMLInputElement;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const next = Math.max(
              0,
              Math.min(rowCount - 1, highlight + (event.key === "ArrowDown" ? 1 : -1)),
            );
            setHighlight(next);
            rowsRef.current?.focus({ preventScroll: true });
            rowsRef.current?.children[next]?.scrollIntoView({ block: "nearest" });
          } else if (
            (event.key === "ArrowLeft" && !typing) ||
            (event.key === "Backspace" && typing && !search)
          ) {
            if (cwd !== null) {
              event.preventDefault();
              goBack();
            }
          } else if (
            !locked &&
            (event.key === "Enter" || (event.key === "ArrowRight" && !typing)) &&
            cwd === null
          ) {
            const project = visibleProjects[highlight];
            if (project) {
              event.preventDefault();
              openProject(project.cwd);
            }
          } else if (!locked && event.key === " " && !typing) {
            if (
              event.target instanceof HTMLElement &&
              event.target.closest('[data-slot="checkbox"]')
            )
              return;
            event.preventDefault();
            const row = cwd === null ? visibleProjects[highlight] : visibleThreads[highlight];
            if (row) {
              if ("importableCount" in row) void toggleProject(row);
              else toggleThread(row);
            }
          }
        }}
      >
        <DialogHeader>
          <div className="flex items-center gap-2 pe-10">
            {(cwd !== null || results !== null) && !importing ? (
              <Button size="icon-sm" variant="ghost" aria-label="Back to projects" onClick={goBack}>
                <ArrowLeftIcon />
              </Button>
            ) : null}
            {!results && cwd ? projectIcon(currentProject?.cwd ?? cwd, projectTitle) : null}
            <DialogTitle className="min-w-0 flex-1 truncate text-lg">
              {results
                ? importing
                  ? `Importing ${completed} of ${results.length}…`
                  : `Imported ${succeeded} of ${results.length}`
                : cwd
                  ? projectTitle
                  : "Import conversations"}
            </DialogTitle>
            {results ? (
              <>
                {failed.length > 0 ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={
                      importing ||
                      failed.some(
                        (item) => checkoutResolution(item.thread).kind === "choose-checkout",
                      )
                    }
                    onClick={() => void importSelection(failed)}
                  >
                    Retry {failed.length} failed
                  </Button>
                ) : null}
                {!importing ? (
                  <Button size="sm" onClick={() => onOpenChange(false)}>
                    Done
                  </Button>
                ) : null}
              </>
            ) : (
              <Button
                size="sm"
                disabled={
                  !selection.size || selectingProject !== null || unresolvedCheckoutCount > 0
                }
                onClick={() => void importSelection()}
              >
                <ImportIcon />
                Import{selection.size ? ` ${selection.size}` : ""}
              </Button>
            )}
          </div>
          <DialogDescription>
            {results
              ? importing
                ? "You can close this window. Imports will continue."
                : failed.length
                  ? "Successful conversations are ready. Failed selections are kept for retry."
                  : "Your conversations are ready in the project sidebar."
              : cwd
                ? "Choose conversations to import. Subagents stay attached to their parent."
                : "Choose projects, or open one to pick conversations."}
          </DialogDescription>
        </DialogHeader>
        {catalogControls}
        <DialogPanel className="space-y-3" scrollFade={false}>
          {results ? (
            <div className="divide-y divide-border/50">
              {results.map((item) => (
                <div key={item.key} className="flex items-center gap-3 py-3">
                  {item.status === "importing" ? (
                    <Spinner className="size-4" />
                  ) : item.status === "success" ? (
                    <CircleCheckIcon className="size-4 text-success" />
                  ) : item.status === "failed" ? (
                    <CircleAlertIcon className="size-4 text-destructive" />
                  ) : (
                    <CircleDashedIcon className="size-4 text-muted-foreground" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">
                      {item.thread.title || "Untitled conversation"}
                    </p>
                    <p className="truncate font-mono text-[11px] text-muted-foreground">
                      {codexImportProjectCwd(item.thread)}
                    </p>
                    <WorktreeBadge thread={item.thread} />
                    {item.error ? (
                      <p className="mt-1 text-xs text-destructive">{item.error}</p>
                    ) : null}
                  </div>
                  {item.threadId && item.status === "success" ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        onOpenChange(false);
                        void navigate({
                          to: "/$environmentId/$threadId",
                          params: buildThreadRouteParams(
                            scopeThreadRef(environmentId, item.threadId!),
                          ),
                        });
                      }}
                    >
                      Open
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      {item.status === "pending"
                        ? "Waiting"
                        : item.status === "importing"
                          ? "Importing"
                          : "Failed"}
                    </span>
                  )}
                </div>
              ))}
            </div>
          ) : providers.length === 0 ? (
            <Empty>
              <EmptyMedia variant="icon">
                <FolderOpenIcon />
              </EmptyMedia>
              <EmptyTitle>Enable a Codex provider</EmptyTitle>
              <EmptyDescription>
                Connect a Codex provider to browse its conversations.
              </EmptyDescription>
              <Button
                variant="outline"
                onClick={() => {
                  onOpenChange(false);
                  void navigate({ to: "/settings" });
                }}
              >
                Open settings
              </Button>
            </Empty>
          ) : (
            <>
              {[...missingProjectCounts].map(([projectCwd, count]) => {
                const project = catalogProjects.get(projectCwd);
                const checkouts = project?.checkouts ?? [];
                const selectedCwd = checkoutChoices.get(projectCwd);
                const selectedCheckout = checkouts.find((checkout) => checkout.cwd === selectedCwd);
                const checkoutLabel = (checkout: (typeof checkouts)[number]) =>
                  `${checkout.isMain ? "Main checkout" : checkout.branch || checkout.cwd.split(/[\\/]/).findLast(Boolean) || checkout.cwd}${checkout.isMain && checkout.branch ? ` · ${checkout.branch}` : ""}`;
                return (
                  <Alert key={projectCwd} variant="warning">
                    <GitBranchIcon />
                    <AlertTitle>
                      {project?.title ?? projectCwd.split(/[\\/]/).findLast(Boolean)} · Removed
                      worktrees
                    </AlertTitle>
                    <AlertDescription>
                      <p>
                        {count
                          ? count === 1
                            ? "1 selected conversation came from a removed worktree. Choose where it should continue."
                            : `${count} selected conversations came from removed worktrees. Choose where they should continue.`
                          : "Choose an existing checkout for conversations from removed worktrees."}{" "}
                        This applies only to removed worktrees in this project.
                      </p>
                      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
                        <span className="shrink-0 text-xs">Continue in</span>
                        <Select
                          value={selectedCheckout?.cwd ?? null}
                          onValueChange={(value) => {
                            setCheckoutChoices((previous) => {
                              const next = new Map(previous);
                              if (value) next.set(projectCwd, value);
                              else next.delete(projectCwd);
                              return next;
                            });
                          }}
                        >
                          <SelectTrigger
                            className="min-w-0 flex-1"
                            size="sm"
                            aria-label={`Checkout for removed worktrees in ${project?.title ?? projectCwd}`}
                            disabled={checkouts.length === 0}
                          >
                            <SelectValue>
                              {selectedCheckout
                                ? checkoutLabel(selectedCheckout)
                                : "Choose checkout…"}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectPopup>
                            {checkouts.map((checkout) => (
                              <SelectItem key={checkout.cwd} value={checkout.cwd}>
                                <span className="min-w-0">
                                  <span className="block truncate">{checkoutLabel(checkout)}</span>
                                  <span className="block truncate font-mono text-[11px] text-muted-foreground">
                                    {checkout.cwd}
                                  </span>
                                </span>
                              </SelectItem>
                            ))}
                          </SelectPopup>
                        </Select>
                      </div>
                      {checkouts.length === 0 ? (
                        <p className="mt-1 text-xs">
                          No existing checkout is available. Restore a checkout, then refresh.
                        </p>
                      ) : null}
                    </AlertDescription>
                  </Alert>
                );
              })}
              {unresolvedCheckoutCount > 0 ? (
                <p role="status" className="text-xs text-warning">
                  Choose a checkout above for {unresolvedCheckoutCount} selected conversations to
                  enable Import.
                </p>
              ) : null}
              {error ? (
                <Alert variant="error">
                  <CircleAlertIcon />
                  <AlertTitle>Could not finish this request</AlertTitle>
                  <AlertDescription>{error}</AlertDescription>
                  <AlertAction>
                    <Button variant="ghost" size="sm" onClick={() => void load()}>
                      Retry
                    </Button>
                  </AlertAction>
                </Alert>
              ) : null}
              {searchScope === "messages" && data.messageSearchSupported === false ? (
                <Alert variant="info">
                  <AlertDescription>
                    Full message search is unavailable for this provider. Choose Titles to search
                    conversation metadata.
                  </AlertDescription>
                </Alert>
              ) : null}
              {!loading && !data.catalogComplete && data.totalCount > 0 ? (
                <p className="text-xs text-muted-foreground">
                  The catalog is incomplete. Counts show a lower bound; select individual
                  conversations or refresh.
                </p>
              ) : null}
              {loading && data.threads.length === 0 ? (
                <div className="space-y-2">
                  {[0, 1, 2].map((key) => (
                    <Skeleton key={key} className="h-9 w-full" />
                  ))}
                </div>
              ) : rowCount === 0 && !error ? (
                <Empty>
                  <EmptyMedia variant="icon">
                    <FolderOpenIcon />
                  </EmptyMedia>
                  <EmptyTitle>No conversations found</EmptyTitle>
                  <EmptyDescription>
                    {hideImported
                      ? "No new conversations or history upgrades match these filters. Turn off Hide already imported to see previous imports."
                      : search || archived || origin
                        ? "No conversations match these filters. Try another search or clear a filter."
                        : "There are no saved Codex conversations in this location."}
                  </EmptyDescription>
                </Empty>
              ) : (
                <div
                  ref={rowsRef}
                  role="group"
                  aria-label={cwd === null ? "Projects" : "Conversations"}
                  className="space-y-0.5"
                  tabIndex={0}
                >
                  {cwd === null
                    ? visibleProjects.map((project, index) => {
                        const state = projectSelection(project);
                        return (
                          <div
                            key={project.cwd}
                            className={cn(
                              "flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted/40",
                              highlight === index && "bg-accent/50",
                            )}
                            onFocus={() => setHighlight(index)}
                          >
                            <Checkbox
                              aria-label={`Select ${project.title}`}
                              checked={state.checked}
                              indeterminate={state.indeterminate}
                              disabled={locked || !project.importableCount || !data.catalogComplete}
                              onCheckedChange={() => void toggleProject(project)}
                            />
                            <button
                              type="button"
                              className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                              onClick={() => openProject(project.cwd)}
                            >
                              {projectIcon(project.cwd, project.title)}
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm font-medium">
                                  {project.title}
                                </span>
                                <span className="block truncate font-mono text-[11px] text-muted-foreground">
                                  {project.cwd || "Unknown folder"}
                                </span>
                              </span>
                              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                                {ORIGINS.filter((value) => project[`${value}Count`] > 0).map(
                                  (value) => (
                                    <OriginIcon key={value} origin={value} />
                                  ),
                                )}
                                <span
                                  className="min-w-8 text-right tabular-nums"
                                  aria-label="Top-level conversations"
                                >
                                  {project.totalCount}
                                  {data.catalogComplete ? "" : "+"}
                                </span>
                                <ChevronRightIcon className="size-3.5" />
                              </span>
                            </button>
                          </div>
                        );
                      })
                    : visibleThreads.map((thread, index) => (
                        <label
                          key={thread.sourceIdentity}
                          className={cn(
                            "flex min-h-9 cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted/40 [content-visibility:auto] has-disabled:cursor-default",
                            highlight === index && "bg-accent/50",
                          )}
                          onFocus={() => setHighlight(index)}
                        >
                          <Checkbox
                            aria-label={`Select ${thread.title || "Untitled conversation"}`}
                            checked={
                              providerInstanceId
                                ? selectedKeys.has(codexImportKey(providerInstanceId, thread))
                                : false
                            }
                            disabled={
                              !canImportCodexConversation(thread) ||
                              selectingProject !== null ||
                              pendingSearch
                            }
                            onCheckedChange={() => toggleThread(thread)}
                          />
                          <OriginIcon origin={thread.origin} />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              {thread.archived ? (
                                <ArchiveIcon className="size-3 shrink-0 text-muted-foreground" />
                              ) : null}
                              <span className="truncate text-sm">
                                {thread.title || "Untitled conversation"}
                              </span>
                            </div>
                            <WorktreeBadge thread={thread} />
                            {thread.matchPreview ? (
                              <p className="truncate text-xs text-muted-foreground">
                                {thread.matchPreview}
                              </p>
                            ) : null}
                          </div>
                          <span className="flex shrink-0 items-center gap-1.5">
                            {thread.historyUpgradeAvailable ? (
                              <Badge size="sm" variant="info">
                                History upgrade
                              </Badge>
                            ) : thread.existingThreadId ? (
                              <Badge size="sm" variant="outline">
                                Imported
                              </Badge>
                            ) : null}
                            {thread.childCount > 0 ? (
                              <Tooltip>
                                <TooltipTrigger render={<span />}>
                                  <Badge size="sm" variant="secondary">
                                    {thread.childCount} subagents
                                  </Badge>
                                </TooltipTrigger>
                                <TooltipPopup>
                                  Subagent conversations stay attached to this parent.
                                </TooltipPopup>
                              </Tooltip>
                            ) : null}
                            <span className="w-14 text-right text-[11px] text-muted-foreground">
                              {formatRelativeTimeLabel(thread.updatedAt)}
                            </span>
                          </span>
                        </label>
                      ))}
                </div>
              )}
              {cwd !== null && data.nextCursor ? (
                <div ref={sentinelRef} className="flex justify-center py-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={loading || pendingSearch}
                    onClick={() => void load(data.nextCursor!)}
                  >
                    {loading ? <Spinner className="size-3.5" /> : null}Load older
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </DialogPanel>
        <DialogFooter variant="bare" className="items-center sm:justify-between">
          <span role="status" className="text-xs text-muted-foreground">
            {results
              ? `${completed} of ${results.length} finished${failed.length ? ` · ${failed.length} failed` : ""}`
              : `${selection.size} selected across ${new Set([...selection.values()].map((item) => codexImportProjectCwd(item.thread))).size} projects${unresolvedCheckoutCount ? ` · ${unresolvedCheckoutCount} need checkout` : ""}`}
          </span>
          <span className="flex items-center gap-2 text-xs text-muted-foreground max-sm:hidden">
            {results ? null : (
              <>
                <Kbd>↑ ↓</Kbd>
                <span>navigate</span>
                <Kbd>Space</Kbd>
                <span>select</span>
                <Kbd>⌘ ↵</Kbd>
                <span>import</span>
              </>
            )}
          </span>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function WorktreeBadge({ thread }: { thread: CodexImportCandidate }) {
  const worktree = codexImportWorktree(thread);
  if (!worktree && !thread.worktreeMissing) return null;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="mt-1 flex min-w-0" />}>
        <Badge
          size="sm"
          variant={thread.worktreeMissing ? "outline" : "secondary"}
          className="max-w-full gap-1 text-muted-foreground"
        >
          <GitBranchIcon className="size-3 shrink-0" />
          <span className="truncate font-mono">
            {worktree?.label ?? thread.cwd.split(/[\\/]/).findLast(Boolean)}
            {thread.worktreeMissing ? " · Removed" : ""}
          </span>
        </Badge>
      </TooltipTrigger>
      <TooltipPopup className="max-w-96 break-all">
        {thread.worktreeMissing ? "Removed worktree" : "Worktree"}: {worktree?.path ?? thread.cwd}
      </TooltipPopup>
    </Tooltip>
  );
}

function OriginIcon({ origin }: { origin: CodexConversationOrigin }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className="relative inline-flex size-4 shrink-0 text-muted-foreground"
            aria-label={ORIGIN_LABELS[origin]}
          />
        }
      >
        {origin === "human" ? (
          <UserRoundIcon className="size-4" />
        ) : origin === "agent" ? (
          <BotIcon className="size-4" />
        ) : origin === "mixed" ? (
          <>
            <UserRoundIcon className="absolute inset-0 size-4 [clip-path:polygon(0_0,calc(100%_-_1px)_0,0_calc(100%_-_1px))]" />
            <BotIcon className="absolute inset-0 size-4 [clip-path:polygon(100%_1px,100%_100%,1px_100%)]" />
          </>
        ) : (
          <CircleDashedIcon className="size-4" />
        )}
      </TooltipTrigger>
      <TooltipPopup>{ORIGIN_LABELS[origin]}</TooltipPopup>
    </Tooltip>
  );
}
