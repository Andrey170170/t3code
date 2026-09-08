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
import {
  findProjectByPath,
  inferProjectTitleFromPath,
  normalizeProjectPathForComparison,
} from "@t3tools/client-runtime/state/projects";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  CodexConversationOrigin,
  CodexThreadsListResult,
  EnvironmentId,
  ProjectId as ProjectIdType,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { ProjectId } from "@t3tools/contracts";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { ErrorBanner } from "../../components/ErrorBanner";
import { ThemedSwitch } from "../../components/ThemedSwitch";
import { cn } from "../../lib/cn";
import { uuidv4 } from "../../lib/uuid";
import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { codexThreads } from "../../state/codex-threads";
import { useProjects, useServerConfigs } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { useDebouncedValue } from "../../state/queries";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { SettingsSection } from "./components/SettingsSection";

type CatalogProject = CodexThreadsListResult["projects"][number];
type CatalogCheckout = NonNullable<CatalogProject["checkouts"]>[number];
type OriginFilter = CodexConversationOrigin | "all";
type SearchScope = "titles" | "messages";

interface EnvironmentOption {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

interface ImportFlow {
  readonly activate: () => () => void;
  readonly archived: boolean;
  readonly catalog: CodexThreadsListResult | null;
  readonly catalogRevision: number;
  readonly environmentId: EnvironmentId | null;
  readonly environmentOptions: ReadonlyArray<EnvironmentOption>;
  readonly error: string | null;
  readonly failed: ReadonlyMap<string, CodexImportCandidate>;
  readonly filterKey: string;
  readonly importing: boolean;
  readonly checkoutChoices: ReadonlyMap<string, string>;
  readonly knownProjects: ReadonlyMap<string, CatalogProject>;
  readonly loadingCatalog: boolean;
  readonly matchingKeys: ReadonlyMap<string, ReadonlySet<string>>;
  readonly origin: OriginFilter;
  readonly projectSelectionBusy: string | null;
  readonly providerId: ProviderInstanceId | null;
  readonly providers: ReadonlyArray<{
    readonly displayName?: string;
    readonly instanceId: ProviderInstanceId;
  }>;
  readonly search: string;
  readonly searchScope: SearchScope;
  readonly selected: ReadonlyMap<string, CodexImportCandidate>;
  readonly status: string | null;
  readonly unresolvedCheckoutCount: number;
  readonly importSelected: () => Promise<void>;
  readonly loadProjectPage: (
    cwd: string,
    cursor?: string,
    refresh?: boolean,
  ) => Promise<CodexThreadsListResult>;
  readonly refreshCatalog: () => Promise<void>;
  readonly setArchived: (value: boolean) => void;
  readonly setCheckoutChoice: (projectCwd: string, checkoutCwd: string) => void;
  readonly setEnvironmentId: (value: EnvironmentId) => void;
  readonly setOrigin: (value: OriginFilter) => void;
  readonly setProviderId: (value: ProviderInstanceId) => void;
  readonly setSearch: (value: string) => void;
  readonly setSearchScope: (value: SearchScope) => void;
  readonly toggleCandidate: (candidate: CodexImportCandidate) => void;
  readonly toggleProject: (project: CatalogProject) => Promise<void>;
}

const ImportFlowContext = createContext<ImportFlow | null>(null);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameCwd(left: string, right: string): boolean {
  return normalizeProjectPathForComparison(left) === normalizeProjectPathForComparison(right);
}

export function SettingsCodexImportProvider(props: { readonly children: ReactNode }) {
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const list = useAtomCommand(codexThreads.list, { reportFailure: false });
  const adopt = useAtomCommand(codexThreads.import, { reportFailure: false });
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const [active, setActive] = useState(false);
  const activeScreenCountRef = useRef(0);
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(null);
  const [selectedProviderId, setSelectedProviderId] = useState<ProviderInstanceId | null>(null);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search, 300).trim();
  const [searchScope, setSearchScope] = useState<SearchScope>("titles");
  const [origin, setOrigin] = useState<OriginFilter>("all");
  const [archived, setArchived] = useState(false);
  const [catalog, setCatalog] = useState<CodexThreadsListResult | null>(null);
  const [knownProjects, setKnownProjects] = useState<Map<string, CatalogProject>>(new Map());
  const [checkoutChoices, setCheckoutChoices] = useState<Map<string, string>>(new Map());
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [selected, setSelected] = useState<Map<string, CodexImportCandidate>>(new Map());
  const [failed, setFailed] = useState<Map<string, CodexImportCandidate>>(new Map());
  const [matchingKeys, setMatchingKeys] = useState<Map<string, Set<string>>>(new Map());
  const [projectSelectionBusy, setProjectSelectionBusy] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const catalogGenerationRef = useRef(0);
  const scopeRef = useRef("");

  const environmentOptions = useMemo<ReadonlyArray<EnvironmentOption>>(() => {
    const ids = new Set<EnvironmentId>();
    for (const connection of Object.values(savedConnectionsById)) ids.add(connection.environmentId);
    for (const environmentId of serverConfigs.keys()) ids.add(environmentId);
    return [...ids]
      .map((environmentId) => ({
        environmentId,
        label:
          savedConnectionsById[environmentId]?.environmentLabel ??
          serverConfigs.get(environmentId)?.environment.label ??
          String(environmentId),
      }))
      .sort((left, right) => left.label.localeCompare(right.label));
  }, [savedConnectionsById, serverConfigs]);

  const environmentId =
    environmentOptions.find((option) => option.environmentId === selectedEnvironmentId)
      ?.environmentId ??
    environmentOptions.find((option) =>
      serverConfigs
        .get(option.environmentId)
        ?.providers.some((provider) => provider.driver === "codex" && provider.enabled),
    )?.environmentId ??
    environmentOptions[0]?.environmentId ??
    null;
  const providers = useMemo(() => {
    const config = environmentId === null ? undefined : serverConfigs.get(environmentId);
    return (
      config?.providers.filter((provider) => provider.driver === "codex" && provider.enabled) ?? []
    );
  }, [environmentId, serverConfigs]);
  const providerId =
    providers.find((provider) => provider.instanceId === selectedProviderId)?.instanceId ??
    providers[0]?.instanceId ??
    null;
  const filterKey = JSON.stringify([
    environmentId,
    providerId,
    archived,
    origin,
    debouncedSearch,
    searchScope,
  ]);
  scopeRef.current = JSON.stringify([filterKey, search.trim()]);

  const requestPage = useCallback(
    async (cwd?: string, cursor?: string, refresh?: boolean) => {
      if (!environmentId || !providerId) throw new Error("Enable a Codex account to continue.");
      const result = await list({
        environmentId,
        input: {
          providerInstanceId: providerId,
          archived,
          ...(origin === "all" ? {} : { origin }),
          ...(debouncedSearch ? { search: debouncedSearch, searchScope } : {}),
          ...(cwd ? { cwd } : {}),
          ...(cursor ? { cursor } : {}),
          ...(refresh ? { refresh: true } : {}),
        },
      });
      if (result._tag !== "Success") {
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        throw new Error("The Codex conversation request was interrupted.");
      }
      setMatchingKeys((current) => {
        const next = new Map(current);
        for (const candidate of result.value.threads) {
          const key = JSON.stringify([filterKey, codexImportProjectCwd(candidate)]);
          const matches = new Set(next.get(key));
          matches.add(candidate.sourceIdentity);
          next.set(key, matches);
        }
        return next;
      });
      setKnownProjects((current) => {
        const next = new Map(current);
        for (const project of result.value.projects) {
          next.set(normalizeProjectPathForComparison(project.cwd), project);
        }
        return next;
      });
      return result.value;
    },
    [archived, debouncedSearch, environmentId, filterKey, list, origin, providerId, searchScope],
  );

  const loadCatalog = useCallback(
    async (refresh = false) => {
      if (!active || !environmentId || !providerId) {
        setCatalog(null);
        return;
      }
      const request = ++catalogGenerationRef.current;
      setLoadingCatalog(true);
      setError(null);
      try {
        const next = await requestPage(undefined, undefined, refresh);
        if (request !== catalogGenerationRef.current) return;
        setCatalog(next);
        setCatalogRevision((revision) => revision + 1);
      } catch (cause) {
        if (request !== catalogGenerationRef.current) return;
        setCatalog(null);
        setError(errorMessage(cause));
      } finally {
        if (request === catalogGenerationRef.current) setLoadingCatalog(false);
      }
    },
    [active, environmentId, providerId, requestPage],
  );

  useEffect(() => {
    void loadCatalog();
  }, [filterKey, loadCatalog]);

  useEffect(() => {
    catalogGenerationRef.current++;
    setSelected(new Map());
    setFailed(new Map());
    setMatchingKeys(new Map());
    setKnownProjects(new Map());
    setCheckoutChoices(new Map());
    setStatus(null);
    setError(null);
  }, [environmentId, providerId]);

  const activate = useCallback(() => {
    activeScreenCountRef.current++;
    setActive(true);
    return () => {
      activeScreenCountRef.current--;
      if (activeScreenCountRef.current > 0) return;
      catalogGenerationRef.current++;
      setActive(false);
      setCatalog(null);
      setSelected(new Map());
      setFailed(new Map());
      setMatchingKeys(new Map());
      setKnownProjects(new Map());
      setCheckoutChoices(new Map());
      setStatus(null);
      setError(null);
    };
  }, []);

  const loadProjectPage = useCallback(
    (cwd: string, cursor?: string, refresh?: boolean) => requestPage(cwd, cursor, refresh),
    [requestPage],
  );

  const toggleCandidate = useCallback(
    (candidate: CodexImportCandidate) => {
      if (!providerId || !canImportCodexConversation(candidate)) return;
      const key = codexImportKey(providerId, candidate);
      setSelected((current) => {
        const next = new Map(current);
        if (next.has(key)) next.delete(key);
        else next.set(key, candidate);
        return next;
      });
      setFailed(new Map());
      setStatus(null);
      setError(null);
    },
    [providerId],
  );

  const toggleProject = useCallback(
    async (project: CatalogProject) => {
      if (!providerId || importing || projectSelectionBusy || project.importableCount === 0) return;
      const currentMatches = matchingKeys.get(JSON.stringify([filterKey, project.cwd]));
      const selectedCount = [...selected.values()].filter(
        (candidate) =>
          sameCwd(codexImportProjectCwd(candidate), project.cwd) &&
          currentMatches?.has(candidate.sourceIdentity),
      ).length;
      const clear = codexProjectSelectionState(
        selectedCount,
        project.importableCount,
        catalog?.catalogComplete ?? false,
      ).checked;
      setFailed(new Map());
      setStatus(null);
      setError(null);

      const requestedScope = scopeRef.current;
      setProjectSelectionBusy(project.cwd);
      try {
        const candidates: Array<readonly [string, CodexImportCandidate]> = [];
        let cursor: string | undefined;
        do {
          const page = await requestPage(project.cwd, cursor);
          if (!page.catalogComplete) {
            throw new Error(
              "This catalog is incomplete. Refresh it or select individual conversations.",
            );
          }
          for (const candidate of page.threads) {
            if (!canImportCodexConversation(candidate)) continue;
            candidates.push([codexImportKey(providerId, candidate), candidate]);
          }
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        if (requestedScope !== scopeRef.current) return;
        setMatchingKeys((current) =>
          new Map(current).set(
            JSON.stringify([filterKey, project.cwd]),
            new Set(candidates.map(([, candidate]) => candidate.sourceIdentity)),
          ),
        );
        setSelected((current) => updateCodexImportSelection(current, candidates, !clear));
      } catch (cause) {
        if (requestedScope === scopeRef.current) setError(errorMessage(cause));
      } finally {
        setProjectSelectionBusy((cwd) => (cwd === project.cwd ? null : cwd));
      }
    },
    [
      catalog?.catalogComplete,
      filterKey,
      importing,
      matchingKeys,
      projectSelectionBusy,
      providerId,
      requestPage,
      selected,
    ],
  );

  const importCandidates = failed.size > 0 ? [...failed.values()] : [...selected.values()];
  const unresolvedCheckoutCount = importCandidates.filter((candidate) => {
    const projectCwd = codexImportProjectCwd(candidate);
    const projectKey = normalizeProjectPathForComparison(projectCwd);
    const project = knownProjects.get(projectKey);
    return (
      resolveCodexImportCheckout(
        candidate,
        checkoutChoices.get(projectKey),
        project?.checkouts ?? [],
      ).kind === "choose-checkout"
    );
  }).length;

  const importSelected = useCallback(async () => {
    if (!environmentId || !providerId || importing || projectSelectionBusy || selected.size === 0)
      return;
    const candidates = failed.size > 0 ? [...failed.values()] : [...selected.values()];
    const unresolved = candidates.filter((candidate) => {
      const projectCwd = codexImportProjectCwd(candidate);
      const projectKey = normalizeProjectPathForComparison(projectCwd);
      const project = knownProjects.get(projectKey);
      return (
        resolveCodexImportCheckout(
          candidate,
          checkoutChoices.get(projectKey),
          project?.checkouts ?? [],
        ).kind === "choose-checkout"
      );
    });
    if (unresolved.length > 0) {
      setError(
        `Choose an existing checkout for ${unresolved.length} conversation${unresolved.length === 1 ? "" : "s"} from removed worktrees.`,
      );
      return;
    }
    const projectIds = new Map<string, Promise<ProjectIdType>>();
    const failures = new Map<string, CodexImportCandidate>();
    let firstFailureMessage: string | null = null;
    let importedCount = 0;
    setImporting(true);
    setError(null);
    setStatus(`Importing 0 of ${candidates.length}…`);

    const resolveProject = (cwd: string): Promise<ProjectIdType> => {
      const cwdKey = normalizeProjectPathForComparison(cwd);
      const pending = projectIds.get(cwdKey);
      if (pending) return pending;
      const resolution = (async () => {
        const existing = findProjectByPath(
          projects.filter((project) => project.environmentId === environmentId),
          cwd,
        );
        if (existing) return existing.id;
        const catalogProject = knownProjects.get(normalizeProjectPathForComparison(cwd));
        if (catalogProject?.existingProjectId) return catalogProject.existingProjectId;

        const projectId = ProjectId.make(uuidv4());
        const result = await createProject({
          environmentId,
          input: {
            projectId,
            title: inferProjectTitleFromPath(cwd),
            workspaceRoot: cwd,
            createWorkspaceRootIfMissing: false,
            defaultModelSelection: null,
          },
        });
        if (result._tag !== "Success") {
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          throw new Error(`Adding ${cwd} was interrupted.`);
        }
        return projectId;
      })();
      projectIds.set(cwdKey, resolution);
      return resolution;
    };

    await runCodexImportBatch(
      candidates,
      async (candidate) => {
        const projectCwd = codexImportProjectCwd(candidate);
        const projectKey = normalizeProjectPathForComparison(projectCwd);
        const projectId = await resolveProject(projectCwd);
        const project = knownProjects.get(projectKey);
        const checkout = resolveCodexImportCheckout(
          candidate,
          checkoutChoices.get(projectKey),
          project?.checkouts ?? [],
        );
        if (checkout.kind === "choose-checkout") {
          throw new Error("Choose an existing checkout before importing this conversation.");
        }
        const result = await adopt({
          environmentId,
          input: {
            providerInstanceId: providerId,
            nativeThreadId: candidate.id,
            archived: candidate.archived,
            projectId,
            ...(checkout.kind === "chosen-checkout" ? { cwdOverride: checkout.cwdOverride } : {}),
          },
        });
        if (result._tag !== "Success") {
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          throw new Error("The conversation import was interrupted.");
        }
        return result.value;
      },
      (candidate, result) => {
        const key = codexImportKey(providerId, candidate);
        if (result.ok) {
          importedCount++;
          setSelected((current) => {
            const next = new Map(current);
            next.delete(key);
            return next;
          });
        } else {
          failures.set(key, candidate);
          firstFailureMessage ??= errorMessage(result.error);
        }
        setStatus(`Importing ${importedCount + failures.size} of ${candidates.length}…`);
      },
    );

    await loadCatalog(true);
    setFailed(failures);
    setImporting(false);
    if (failures.size === 0) {
      setStatus(`Imported ${importedCount} conversation${importedCount === 1 ? "" : "s"}.`);
    } else {
      setError(firstFailureMessage);
      setStatus(
        `Imported ${importedCount} of ${candidates.length}. ${failures.size} failed and can be retried.`,
      );
    }
  }, [
    adopt,
    checkoutChoices,
    createProject,
    environmentId,
    failed,
    importing,
    loadCatalog,
    knownProjects,
    projects,
    projectSelectionBusy,
    providerId,
    selected,
  ]);

  const value = useMemo<ImportFlow>(
    () => ({
      activate,
      archived,
      catalog,
      catalogRevision,
      checkoutChoices,
      environmentId,
      environmentOptions,
      error,
      failed,
      filterKey,
      importing,
      knownProjects,
      loadingCatalog,
      matchingKeys,
      origin,
      projectSelectionBusy,
      providerId,
      providers,
      search,
      searchScope,
      selected,
      status,
      unresolvedCheckoutCount,
      importSelected,
      loadProjectPage,
      refreshCatalog: () => loadCatalog(true),
      setArchived,
      setCheckoutChoice: (projectCwd, checkoutCwd) => {
        setCheckoutChoices((current) =>
          new Map(current).set(normalizeProjectPathForComparison(projectCwd), checkoutCwd),
        );
        setError(null);
      },
      setEnvironmentId: (value) => {
        setSelectedEnvironmentId(value);
        setSelectedProviderId(null);
      },
      setOrigin,
      setProviderId: setSelectedProviderId,
      setSearch,
      setSearchScope,
      toggleCandidate,
      toggleProject,
    }),
    [
      activate,
      archived,
      catalog,
      catalogRevision,
      checkoutChoices,
      environmentId,
      environmentOptions,
      error,
      failed,
      filterKey,
      importing,
      knownProjects,
      loadCatalog,
      loadingCatalog,
      loadProjectPage,
      matchingKeys,
      origin,
      projectSelectionBusy,
      providerId,
      providers,
      search,
      searchScope,
      selected,
      status,
      unresolvedCheckoutCount,
      importSelected,
      toggleCandidate,
      toggleProject,
    ],
  );

  return <ImportFlowContext.Provider value={value}>{props.children}</ImportFlowContext.Provider>;
}

function useImportFlow(): ImportFlow {
  const flow = useContext(ImportFlowContext);
  if (!flow) throw new Error("Codex import screens require SettingsCodexImportProvider.");
  return flow;
}

function SelectionIndicator(props: {
  readonly checked: boolean;
  readonly indeterminate?: boolean;
}) {
  const name = props.checked
    ? "checkmark.circle.fill"
    : props.indeterminate
      ? "minus.circle.fill"
      : "circle";
  const fallback = (
    <View
      className={cn(
        "size-5 items-center justify-center rounded-full border-2",
        props.checked || props.indeterminate
          ? "border-primary bg-primary"
          : "border-foreground-muted",
      )}
    >
      {props.checked || props.indeterminate ? (
        <SymbolView
          name={props.checked ? "checkmark" : { ios: "minus", android: "remove" }}
          size={12}
          tintColorClassName="accent-primary-foreground"
          type="monochrome"
          weight="bold"
        />
      ) : null}
    </View>
  );
  return (
    <SymbolView
      name={name}
      fallback={fallback}
      size={21}
      tintColorClassName={
        props.checked || props.indeterminate ? "accent-icon" : "accent-icon-muted"
      }
      type="monochrome"
    />
  );
}

function OriginSymbol(props: { readonly origin: CodexConversationOrigin }) {
  if (props.origin === "mixed") {
    return (
      <View accessibilityLabel="Started by an agent, continued by you" className="relative size-5">
        <View className="absolute inset-y-0 left-0 w-2.5 overflow-hidden">
          <SymbolView
            name="person.crop.circle"
            size={19}
            tintColorClassName="accent-icon-muted"
            type="monochrome"
          />
        </View>
        <View className="absolute inset-y-0 right-0 w-2.5 items-end overflow-hidden">
          <View className="w-5 items-end">
            <SymbolView
              name="brain"
              size={18}
              tintColorClassName="accent-icon-muted"
              type="monochrome"
            />
          </View>
        </View>
      </View>
    );
  }
  if (props.origin === "human") {
    return (
      <SymbolView
        accessibilityLabel="Started by you"
        name="person.crop.circle"
        size={19}
        tintColorClassName="accent-icon-muted"
        type="monochrome"
      />
    );
  }
  if (props.origin === "agent") {
    return (
      <SymbolView
        accessibilityLabel="Started by an agent"
        name="brain"
        size={18}
        tintColorClassName="accent-icon-muted"
        type="monochrome"
      />
    );
  }
  return (
    <SymbolView
      accessibilityLabel="Origin unknown"
      fallback={
        <SymbolView
          name="ellipsis.circle"
          size={18}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
        />
      }
      name="questionmark.circle"
      size={18}
      tintColorClassName="accent-icon-muted"
      type="monochrome"
    />
  );
}

function ChoiceChip(props: {
  readonly disabled?: boolean;
  readonly label: string;
  readonly selected: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: props.selected }}
      disabled={props.disabled}
      className={cn(
        "rounded-full px-3.5 py-2 active:opacity-70",
        props.selected ? "bg-primary" : "bg-card",
        props.disabled && "opacity-45",
      )}
      onPress={props.onPress}
    >
      <Text
        className={cn(
          "text-sm font-t3-medium",
          props.selected ? "text-primary-foreground" : "text-foreground",
        )}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

function FilterControls() {
  const flow = useImportFlow();
  return (
    <View className="gap-3">
      <TextInput
        accessibilityLabel="Search Codex conversations"
        autoCapitalize="none"
        autoCorrect={false}
        className="h-11 rounded-xl bg-card px-4 font-sans text-base text-foreground"
        onChangeText={flow.setSearch}
        editable={!flow.importing}
        placeholder="Search conversations"
        placeholderTextColorClassName="accent-placeholder"
        value={flow.search}
      />
      <ScrollView
        horizontal
        contentContainerClassName="gap-2"
        keyboardShouldPersistTaps="handled"
        showsHorizontalScrollIndicator={false}
      >
        <ChoiceChip
          label="Titles"
          disabled={flow.importing}
          onPress={() => flow.setSearchScope("titles")}
          selected={flow.searchScope === "titles"}
        />
        <ChoiceChip
          label="Messages"
          disabled={flow.importing}
          onPress={() => flow.setSearchScope("messages")}
          selected={flow.searchScope === "messages"}
        />
        {(
          [
            ["all", "Any origin"],
            ["human", "You"],
            ["agent", "Agent"],
            ["mixed", "Mixed"],
            ["unknown", "Unknown"],
          ] as const
        ).map(([value, label]) => (
          <ChoiceChip
            key={value}
            label={label}
            disabled={flow.importing}
            onPress={() => flow.setOrigin(value)}
            selected={flow.origin === value}
          />
        ))}
      </ScrollView>
      <View className="min-h-11 flex-row items-center justify-between rounded-xl bg-card px-4">
        <Text className="text-sm font-t3-medium text-foreground">Archived conversations</Text>
        <ThemedSwitch
          accessibilityLabel="Archived conversations"
          disabled={flow.importing}
          onValueChange={flow.setArchived}
          value={flow.archived}
        />
      </View>
    </View>
  );
}

function HeaderImportAction() {
  const flow = useImportFlow();
  const count = flow.failed.size > 0 ? flow.failed.size : flow.selected.size;
  const label = flow.failed.size > 0 ? `Retry ${count}` : `Import ${count}`;
  const disabled =
    count === 0 ||
    flow.importing ||
    flow.projectSelectionBusy !== null ||
    flow.unresolvedCheckoutCount > 0;
  if (Platform.OS === "android") {
    return (
      <Pressable
        accessibilityRole="button"
        disabled={disabled}
        onPress={() => void flow.importSelected()}
        className={cn("px-2 py-2", disabled && "opacity-45")}
      >
        <Text className="text-sm font-t3-bold text-accent">
          {flow.importing ? "Importing…" : label}
        </Text>
      </Pressable>
    );
  }
  return (
    <NativeHeaderToolbar placement="right">
      <NativeHeaderToolbar.Button
        accessibilityLabel={label}
        disabled={disabled}
        label={flow.importing ? "Importing…" : label}
        onPress={() => void flow.importSelected()}
      />
    </NativeHeaderToolbar>
  );
}

function ScreenHeader(props: { readonly title: string }) {
  const navigation = useNavigation();
  return Platform.OS === "android" ? (
    <>
      <NativeStackScreenOptions options={{ headerShown: false }} />
      <AndroidScreenHeader
        title={props.title}
        onBack={() => navigation.goBack()}
        trailing={<HeaderImportAction />}
      />
    </>
  ) : (
    <>
      <NativeStackScreenOptions options={{ title: props.title }} />
      <HeaderImportAction />
    </>
  );
}

function SelectionStatus() {
  const flow = useImportFlow();
  if (!flow.status && flow.selected.size === 0 && flow.unresolvedCheckoutCount === 0) return null;
  return (
    <View className="gap-1 px-1">
      {flow.unresolvedCheckoutCount > 0 ? (
        <Text accessibilityRole="alert" className="text-sm text-warning-foreground">
          {flow.unresolvedCheckoutCount} selected conversation
          {flow.unresolvedCheckoutCount === 1 ? " needs" : "s need"} an existing checkout.
        </Text>
      ) : null}
      {flow.status || flow.selected.size > 0 ? (
        <Text accessibilityRole="summary" className="text-sm text-foreground-muted">
          {flow.status ?? `${flow.selected.size} selected`}
        </Text>
      ) : null}
    </View>
  );
}

function EnvironmentAndProviderPickers() {
  const flow = useImportFlow();
  return (
    <>
      {flow.environmentOptions.length > 1 ? (
        <SettingsSection title="Environment" card>
          {flow.environmentOptions.map((option, index) => (
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ checked: option.environmentId === flow.environmentId }}
              className={cn(
                "min-h-12 flex-row items-center gap-3 px-4 py-3 active:bg-subtle",
                index < flow.environmentOptions.length - 1 && "border-b border-border-subtle",
                flow.importing && "opacity-45",
              )}
              key={option.environmentId}
              disabled={flow.importing}
              onPress={() => flow.setEnvironmentId(option.environmentId)}
            >
              <SelectionIndicator checked={option.environmentId === flow.environmentId} />
              <Text
                className="min-w-0 flex-1 text-sm font-t3-medium text-foreground"
                numberOfLines={1}
              >
                {option.label}
              </Text>
            </Pressable>
          ))}
        </SettingsSection>
      ) : null}
      {flow.providers.length > 1 ? (
        <SettingsSection title="Codex account" card>
          {flow.providers.map((provider, index) => (
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ checked: provider.instanceId === flow.providerId }}
              className={cn(
                "min-h-12 flex-row items-center gap-3 px-4 py-3 active:bg-subtle",
                index < flow.providers.length - 1 && "border-b border-border-subtle",
                flow.importing && "opacity-45",
              )}
              key={provider.instanceId}
              disabled={flow.importing}
              onPress={() => flow.setProviderId(provider.instanceId)}
            >
              <SelectionIndicator checked={provider.instanceId === flow.providerId} />
              <Text
                className="min-w-0 flex-1 text-sm font-t3-medium text-foreground"
                numberOfLines={1}
              >
                {provider.displayName ?? provider.instanceId}
              </Text>
            </Pressable>
          ))}
        </SettingsSection>
      ) : null}
    </>
  );
}

function checkoutTitle(checkout: CatalogCheckout): string {
  if (checkout.isMain) {
    return checkout.branch ? `Main checkout · ${checkout.branch}` : "Main checkout";
  }
  return (
    checkout.branch ?? checkout.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? "Detached checkout"
  );
}

function CheckoutChoicePanel(props: {
  readonly missingCount: number;
  readonly project: CatalogProject;
}) {
  const flow = useImportFlow();
  const projectKey = normalizeProjectPathForComparison(props.project.cwd);
  const selectedCwd = flow.checkoutChoices.get(projectKey);
  const checkouts = props.project.checkouts ?? [];
  return (
    <View className="gap-2">
      <View className="rounded-2xl border border-warning-border bg-warning px-4 py-3">
        <Text className="text-sm font-t3-bold text-warning-foreground">
          Removed worktrees: continue in
        </Text>
        <Text className="mt-1 text-xs leading-normal text-warning-foreground">
          Choose where {props.missingCount} conversation
          {props.missingCount === 1 ? "" : "s"} from {props.project.title} should continue. Other
          conversations keep their original folders.
        </Text>
      </View>
      {checkouts.length > 0 ? (
        <SettingsSection card>
          {checkouts.map((checkout, index) => (
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ checked: checkout.cwd === selectedCwd }}
              className={cn(
                "min-h-14 flex-row items-center gap-3 bg-card px-4 py-3 active:bg-subtle",
                index < checkouts.length - 1 && "border-b border-border-subtle",
                flow.importing && "opacity-45",
              )}
              disabled={flow.importing}
              key={checkout.cwd}
              onPress={() => flow.setCheckoutChoice(props.project.cwd, checkout.cwd)}
            >
              <SelectionIndicator checked={checkout.cwd === selectedCwd} />
              <SymbolView
                name={checkout.isMain ? "folder" : "arrow.triangle.branch"}
                size={17}
                tintColorClassName="accent-icon-muted"
                type="monochrome"
              />
              <View className="min-w-0 flex-1 gap-0.5">
                <Text className="text-sm font-t3-medium text-foreground" numberOfLines={1}>
                  {checkoutTitle(checkout)}
                </Text>
                <Text
                  className="text-xs text-foreground-muted"
                  ellipsizeMode="middle"
                  numberOfLines={1}
                >
                  {checkout.cwd}
                </Text>
              </View>
            </Pressable>
          ))}
        </SettingsSection>
      ) : (
        <ErrorBanner message="No existing checkout is available for this project. Refresh the catalog after creating or restoring one." />
      )}
    </View>
  );
}

function SelectedCheckoutPanels() {
  const flow = useImportFlow();
  const missingByProject = new Map<string, number>();
  for (const candidate of flow.selected.values()) {
    if (!candidate.worktreeMissing) continue;
    const key = normalizeProjectPathForComparison(codexImportProjectCwd(candidate));
    missingByProject.set(key, (missingByProject.get(key) ?? 0) + 1);
  }
  return [...missingByProject].map(([projectKey, missingCount]) => {
    const project = flow.knownProjects.get(projectKey);
    return project ? (
      <CheckoutChoicePanel key={projectKey} missingCount={missingCount} project={project} />
    ) : null;
  });
}

function ProjectRow(props: { readonly project: CatalogProject; readonly isLast: boolean }) {
  const flow = useImportFlow();
  const navigation = useNavigation();
  const currentMatches = flow.matchingKeys.get(JSON.stringify([flow.filterKey, props.project.cwd]));
  const selectedCount = [...flow.selected.values()].filter(
    (candidate) =>
      sameCwd(codexImportProjectCwd(candidate), props.project.cwd) &&
      currentMatches?.has(candidate.sourceIdentity),
  ).length;
  const selection = codexProjectSelectionState(
    selectedCount,
    props.project.importableCount,
    flow.catalog?.catalogComplete ?? false,
  );
  const importedCount = props.project.totalCount - props.project.importableCount;
  const counts = [
    `${props.project.totalCount} conversations`,
    `${props.project.humanCount} you`,
    `${props.project.agentCount} agent`,
    props.project.mixedCount > 0 ? `${props.project.mixedCount} mixed` : null,
    props.project.unknownCount > 0 ? `${props.project.unknownCount} unknown` : null,
    importedCount > 0 ? `${importedCount} imported` : null,
  ].filter(Boolean);
  const selecting = flow.projectSelectionBusy === props.project.cwd;
  const selectionBlocked = flow.importing || flow.projectSelectionBusy !== null;

  return (
    <View
      className={cn(
        "min-h-16 flex-row items-center bg-card",
        !props.isLast && "border-b border-border-subtle",
      )}
    >
      <Pressable
        accessibilityLabel={`${selection.checked || selection.indeterminate ? "Clear" : "Select"} ${props.project.title}`}
        accessibilityRole="checkbox"
        accessibilityState={{
          checked: selection.indeterminate ? "mixed" : selection.checked,
          disabled: props.project.importableCount === 0 || selectionBlocked,
        }}
        className="h-full items-center justify-center pl-4 pr-3"
        disabled={props.project.importableCount === 0 || selectionBlocked}
        hitSlop={4}
        onPress={() => void flow.toggleProject(props.project)}
      >
        {selecting ? (
          <ActivityIndicator size="small" colorClassName="accent-icon-muted" />
        ) : (
          <SelectionIndicator checked={selection.checked} indeterminate={selection.indeterminate} />
        )}
      </Pressable>
      <Pressable
        accessibilityLabel={`Open ${props.project.title}, ${counts.join(", ")}`}
        accessibilityRole="button"
        className="min-w-0 flex-1 flex-row items-center gap-3 py-3 pr-4 active:bg-subtle"
        onPress={() =>
          navigation.dispatch(
            StackActions.push("SettingsCodexImportProject", {
              cwd: props.project.cwd,
              title: props.project.title,
            }),
          )
        }
      >
        <SymbolView
          name="folder"
          size={19}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
        />
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-base font-t3-medium text-foreground" numberOfLines={1}>
            {props.project.title}
          </Text>
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            {props.project.cwd}
          </Text>
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            {counts.join(" · ")}
          </Text>
        </View>
        <SymbolView
          name="chevron.right"
          size={14}
          tintColorClassName="accent-chevron"
          type="monochrome"
        />
      </Pressable>
    </View>
  );
}

export function SettingsCodexImportRouteScreen() {
  const flow = useImportFlow();
  const insets = useSafeAreaInsets();
  useEffect(() => flow.activate(), [flow.activate]);

  return (
    <View className="flex-1 bg-sheet" collapsable={false}>
      <ScreenHeader title="Import conversations" />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          gap: 16,
          paddingBottom: Math.max(insets.bottom, 18) + 18,
          paddingHorizontal: 16,
          paddingTop: 12,
        }}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            onRefresh={() => void flow.refreshCatalog()}
            refreshing={flow.loadingCatalog}
          />
        }
        showsVerticalScrollIndicator={false}
      >
        <EnvironmentAndProviderPickers />
        <FilterControls />
        <SelectionStatus />
        <SelectedCheckoutPanels />
        {flow.error ? <ErrorBanner message={flow.error} /> : null}
        {flow.environmentOptions.length === 0 ? (
          <EmptyState
            title="No environment available"
            detail="Connect an environment before importing Codex conversations."
          />
        ) : flow.providers.length === 0 ? (
          <EmptyState
            title="Enable a Codex account"
            detail="This environment has no enabled Codex account. Enable one in Settings, then return here."
          />
        ) : flow.loadingCatalog && !flow.catalog ? (
          <View className="items-center py-10">
            <ActivityIndicator colorClassName="accent-icon-muted" />
          </View>
        ) : flow.catalog?.projects.length === 0 ? (
          <EmptyState
            title="No conversations found"
            detail="No Codex conversations match the current search and filters."
          />
        ) : flow.catalog ? (
          <SettingsSection title="Projects" card>
            {flow.catalog.projects.map((project, index) => (
              <ProjectRow
                key={normalizeProjectPathForComparison(project.cwd)}
                isLast={index === flow.catalog!.projects.length - 1}
                project={project}
              />
            ))}
          </SettingsSection>
        ) : null}
        {flow.catalog && !flow.catalog.catalogComplete ? (
          <Text className="px-1 text-xs text-foreground-muted">
            Codex returned a bounded catalog. Counts and selection cover every conversation in that
            catalog.
          </Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

function ConversationRow(props: {
  readonly candidate: CodexImportCandidate;
  readonly isLast: boolean;
}) {
  const flow = useImportFlow();
  const key = flow.providerId ? codexImportKey(flow.providerId, props.candidate) : "";
  const selected = flow.selected.has(key);
  const importable = canImportCodexConversation(props.candidate);
  const worktree = codexImportWorktree(props.candidate);
  const removedWorktree = props.candidate.worktreeMissing === true;
  const worktreeLabel =
    worktree?.label ?? props.candidate.worktreeBranch?.trim() ?? "Unknown branch";
  const worktreePath = worktree?.path ?? props.candidate.cwd;
  const subtitle = props.candidate.matchPreview;
  return (
    <Pressable
      accessibilityHint={worktree || removedWorktree ? `Worktree path ${worktreePath}` : undefined}
      accessibilityLabel={`${props.candidate.title || "Untitled conversation"}, ${props.candidate.origin}${removedWorktree ? `, removed worktree ${worktreeLabel}` : worktree ? `, worktree ${worktreeLabel}` : ""}${props.candidate.childCount > 0 ? `, ${props.candidate.childCount} subagents` : ""}`}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected, disabled: !importable || flow.importing }}
      className={cn(
        "min-h-16 flex-row items-center gap-3 bg-card px-4 py-3 active:bg-subtle",
        !props.isLast && "border-b border-border-subtle",
      )}
      disabled={!importable || flow.importing}
      onPress={() => flow.toggleCandidate(props.candidate)}
      style={{ opacity: importable ? 1 : 0.55 }}
    >
      <SelectionIndicator checked={selected} />
      <OriginSymbol origin={props.candidate.origin} />
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-base font-t3-medium text-foreground" numberOfLines={1}>
          {props.candidate.title || "Untitled conversation"}
        </Text>
        {subtitle ? (
          <Text className="text-xs text-foreground-muted" numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
        {worktree || removedWorktree ? (
          <View className="min-w-0 flex-row items-center gap-1.5">
            <View
              className={cn(
                "flex-row items-center gap-1 rounded-full px-2 py-0.5",
                removedWorktree ? "bg-warning" : "bg-subtle",
              )}
            >
              <SymbolView
                name={removedWorktree ? "exclamationmark.triangle" : "arrow.triangle.branch"}
                size={11}
                tintColorClassName={
                  removedWorktree ? "accent-warning-foreground" : "accent-icon-muted"
                }
                type="monochrome"
              />
              <Text
                className={cn(
                  "max-w-44 text-[11px] font-t3-medium",
                  removedWorktree ? "text-warning-foreground" : "text-foreground-muted",
                )}
                numberOfLines={1}
              >
                {removedWorktree ? `Removed worktree · ${worktreeLabel}` : worktreeLabel}
              </Text>
            </View>
            <Text
              className="min-w-0 flex-1 text-[11px] text-foreground-muted"
              ellipsizeMode="middle"
              numberOfLines={1}
            >
              {worktreePath}
            </Text>
          </View>
        ) : null}
        <Text className="text-xs text-foreground-muted" numberOfLines={1}>
          {new Date(props.candidate.updatedAt).toLocaleDateString()}
          {props.candidate.childCount > 0
            ? ` · ${props.candidate.childCount} subagent${props.candidate.childCount === 1 ? "" : "s"}`
            : ""}
          {!importable
            ? " · Already imported"
            : props.candidate.historyUpgradeAvailable
              ? " · History upgrade"
              : ""}
        </Text>
      </View>
    </Pressable>
  );
}

type ProjectRouteParams = { readonly cwd: string; readonly title: string };

export function SettingsCodexImportProjectRouteScreen({
  route,
}: StaticScreenProps<ProjectRouteParams>) {
  const flow = useImportFlow();
  const insets = useSafeAreaInsets();
  const [threads, setThreads] = useState<ReadonlyArray<CodexImportCandidate>>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);
  useEffect(() => flow.activate(), [flow.activate]);

  const projectKey = normalizeProjectPathForComparison(route.params.cwd);
  const project = flow.knownProjects.get(projectKey);
  const missingCandidates = new Map<string, CodexImportCandidate>();
  for (const candidate of [...threads, ...flow.selected.values()]) {
    if (
      candidate.worktreeMissing &&
      canImportCodexConversation(candidate) &&
      sameCwd(codexImportProjectCwd(candidate), route.params.cwd)
    ) {
      missingCandidates.set(candidate.sourceIdentity, candidate);
    }
  }

  const load = useCallback(
    async (cursor?: string, refresh?: boolean) => {
      const request = ++generationRef.current;
      setLoading(true);
      setError(null);
      try {
        const page = await flow.loadProjectPage(route.params.cwd, cursor, refresh);
        if (request !== generationRef.current) return;
        setThreads((current) => {
          const rows = cursor ? [...current, ...page.threads] : page.threads;
          return [
            ...new Map(rows.map((candidate) => [candidate.sourceIdentity, candidate])).values(),
          ];
        });
        setNextCursor(page.nextCursor);
      } catch (cause) {
        if (request === generationRef.current) setError(errorMessage(cause));
      } finally {
        if (request === generationRef.current) setLoading(false);
      }
    },
    [flow.loadProjectPage, route.params.cwd],
  );

  useEffect(() => {
    generationRef.current++;
    setThreads([]);
    setNextCursor(null);
    void load();
  }, [flow.catalogRevision, flow.filterKey, load]);

  useEffect(
    () => () => {
      generationRef.current++;
    },
    [],
  );

  return (
    <View className="flex-1 bg-sheet" collapsable={false}>
      <ScreenHeader title={route.params.title} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          gap: 16,
          paddingBottom: Math.max(insets.bottom, 18) + 18,
          paddingHorizontal: 16,
          paddingTop: 12,
        }}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            onRefresh={() => void flow.refreshCatalog()}
            refreshing={loading || flow.loadingCatalog}
          />
        }
        showsVerticalScrollIndicator={false}
      >
        <FilterControls />
        <SelectionStatus />
        {project && missingCandidates.size > 0 ? (
          <CheckoutChoicePanel missingCount={missingCandidates.size} project={project} />
        ) : null}
        {flow.error ? <ErrorBanner message={flow.error} /> : null}
        {error ? <ErrorBanner message={error} /> : null}
        {loading && threads.length === 0 ? (
          <View className="items-center py-10">
            <ActivityIndicator colorClassName="accent-icon-muted" />
          </View>
        ) : threads.length === 0 ? (
          <EmptyState
            title="No conversations found"
            detail="No conversations in this project match the current search and filters."
          />
        ) : (
          <SettingsSection card>
            {threads.map((candidate, index) => (
              <ConversationRow
                candidate={candidate}
                isLast={index === threads.length - 1}
                key={candidate.sourceIdentity}
              />
            ))}
          </SettingsSection>
        )}
        {nextCursor ? (
          <Pressable
            accessibilityRole="button"
            className="self-center rounded-full bg-card px-5 py-3 active:opacity-70"
            disabled={loading}
            onPress={() => void load(nextCursor)}
          >
            <Text className="text-sm font-t3-bold text-accent">
              {loading ? "Loading…" : "Load older conversations"}
            </Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </View>
  );
}
