import type { DraftId } from "~/composerDraftStore";
import { useComposerDraftStore } from "~/composerDraftStore";
import {
  isTrellisLandingPad,
  resolveEnvironmentMachineKind,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { FolderPlusIcon, LightbulbIcon, MessageSquareDashedIcon } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { openCommandPalette } from "~/commandPaletteBus";
import { shortcutLabelForCommand } from "~/keybindings";
import { projectIconColorClassName } from "~/projectIconColors";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { useScratchProject } from "~/hooks/useScratchProject";
import { useTrellisCreate, useTrellisStatusFor } from "~/hooks/useTrellis";
import { HOST_NO_PROJECT_LABEL, noProjectKind, type NoProjectKind } from "~/lib/trellis";
import { useClientSettings } from "~/hooks/useSettings";
import { hasExplicitComposerModelSelection } from "~/lib/chatThreadActions";
import { deriveLogicalProjectKeyFromSettings } from "~/logicalProject";
import {
  buildSidebarProjectPickerEntries,
  buildSidebarProjectSnapshots,
  projectGroupsSpanEnvironments,
} from "~/sidebarProjectGrouping";
import { useProjects, useThreadShells } from "~/state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { ProjectEnvironmentBadge } from "../ProjectEnvironmentBadge";
import { ProjectFavicon } from "../ProjectFavicon";
import { sortLogicalProjectsForSidebar } from "../Sidebar.logic";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { InlineButton } from "../ui/button";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useProjectGroupingSettings } from "~/hooks/useProjectGroupingSettings";

// Menu values for "No project" and a Trellis "New idea"; real entries are
// keyed by logical project key.
const NO_PROJECT_VALUE = "no-project";
const NEW_IDEA_VALUE = "new-idea";

interface DraftHeroHeadlineProps {
  readonly draftId: DraftId | null;
  readonly activeProjectRef: ScopedProjectRef | null;
  readonly activeProjectTitle: string | null;
}

export function DraftHeroHeadline({
  draftId,
  activeProjectRef,
  activeProjectTitle,
}: DraftHeroHeadlineProps) {
  const projects = useProjects();
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupingSettings = useProjectGroupingSettings();
  const projectSortOrder = useClientSettings((settings) => settings.sidebarProjectSortOrder);
  const setLogicalProjectDraftThreadId = useComposerDraftStore(
    (store) => store.setLogicalProjectDraftThreadId,
  );
  const getComposerDraft = useComposerDraftStore((store) => store.getComposerDraft);
  const applyStickyState = useComposerDraftStore((store) => store.applyStickyState);
  const setModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const openAddProject = useCallback(() => openCommandPalette({ open: "add-project" }), []);
  const { scratchEnvironmentId, scratchWorkspaceRootFor, openScratchProject } = useScratchProject();
  const { openIdeaProject } = useTrellisCreate();
  // Where a thread without a project would start: the draft's environment.
  const noProjectEnvironmentId = activeProjectRef?.environmentId ?? primaryEnvironmentId;
  const trellisState = useTrellisStatusFor(noProjectEnvironmentId)?.state ?? null;
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);

  const environmentLabelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  const projectGroups = useMemo(
    () =>
      sortLogicalProjectsForSidebar(
        buildSidebarProjectSnapshots({
          projects,
          settings: projectGroupingSettings,
          primaryEnvironmentId,
          resolveEnvironmentLabel: (environmentId) =>
            environmentLabelById.get(environmentId) ?? null,
        }),
        threads,
        projectSortOrder,
      ),
    [
      environmentLabelById,
      primaryEnvironmentId,
      projectGroupingSettings,
      projectSortOrder,
      projects,
      threads,
    ],
  );
  // Same-named projects on two machines are only told apart by where they
  // live, so rows on another machine carry its icon once the catalog spans
  // more than one environment; a single-machine catalog stays as it was.
  const showProjectEnvironments = useMemo(
    () => projectGroupsSpanEnvironments(projectGroups),
    [projectGroups],
  );
  const environmentMachineById = useMemo(
    () =>
      new Map(
        environments.map(
          (environment) =>
            [
              environment.environmentId,
              resolveEnvironmentMachineKind(environment.serverConfig),
            ] as const,
        ),
      ),
    [environments],
  );
  const projectPickerEntries = useMemo(
    () =>
      buildSidebarProjectPickerEntries({
        groups: projectGroups,
        preferredProjectRef: activeProjectRef,
      }),
    [activeProjectRef, projectGroups],
  );
  const projectEntryByKey = useMemo(
    () => new Map(projectPickerEntries.map((entry) => [entry.group.projectKey, entry] as const)),
    [projectPickerEntries],
  );
  const activeProjectGroup =
    activeProjectRef === null
      ? null
      : (projectGroups.find((group) =>
          group.memberProjectRefs.some(
            (projectRef) => scopedProjectKey(projectRef) === scopedProjectKey(activeProjectRef),
          ),
        ) ?? null);
  const activeProjectKey = activeProjectGroup?.projectKey ?? "";
  const activeProjectDisplayName = activeProjectGroup?.displayName ?? activeProjectTitle;
  const hasResolvedProject = activeProjectTitle !== null;
  const canChooseProject = projectPickerEntries.length > 0;
  // The project that hosts threads without a project appears once, as the
  // "No project" item, not as a project row.
  const menuEntries = projectPickerEntries.filter(
    ({ targetProject }) =>
      !isScratchProject(targetProject, scratchWorkspaceRootFor(targetProject.environmentId)),
  );
  const activeProject =
    activeProjectRef === null
      ? null
      : (projects.find(
          (project) =>
            project.environmentId === activeProjectRef.environmentId &&
            project.id === activeProjectRef.projectId,
        ) ?? null);
  const scratchTargetEnvironmentId = scratchEnvironmentId(
    activeProjectRef?.environmentId ?? primaryEnvironmentId,
  );
  const scratchWorkspaceRoot = scratchWorkspaceRootFor(scratchTargetEnvironmentId);
  const isScratchDraft =
    activeProject !== null && isScratchProject(activeProject, scratchWorkspaceRoot);
  // A new-idea draft belongs to the Trellis landing pad, which is not a listed
  // project. With Trellis on, "without a project" means such an idea, and the
  // host scratch project is its own, plainly named choice.
  const isIdeaDraft = activeProjectRef !== null && isTrellisLandingPad(activeProjectRef.projectId);
  const withoutProject = noProjectKind({
    trellisState,
    scratchOffered: scratchWorkspaceRoot !== null,
  });
  const ideasOffered = withoutProject === "idea";
  const isNoProjectDraft = isScratchDraft || isIdeaDraft;
  const scratchLabel = ideasOffered ? HOST_NO_PROJECT_LABEL : "No project";
  const shouldShowProjectMenu = canChooseProject || ideasOffered || isIdeaDraft;

  // The picker can change the draft's target while the no-project home is
  // still being opened; a stale continuation must not retarget it again.
  const latestTargetRef = useRef({ draftId, activeProjectKey, scratchTargetEnvironmentId });
  useEffect(() => {
    latestTargetRef.current = { draftId, activeProjectKey, scratchTargetEnvironmentId };
  }, [activeProjectKey, scratchTargetEnvironmentId, draftId]);
  // Project selection changes the target of the open draft in place. The
  // prompt stays in the same composer session, so the sidebar only gets a
  // draft row if the user later navigates away.
  const selectProject = (project: (typeof projects)[number], logicalProjectKey: string) => {
    if (!draftId) {
      return;
    }
    latestTargetRef.current = {
      draftId,
      activeProjectKey: logicalProjectKey,
      scratchTargetEnvironmentId: project.environmentId,
    };
    const currentDraft = getComposerDraft(draftId);
    setLogicalProjectDraftThreadId(
      logicalProjectKey,
      scopeProjectRef(project.environmentId, project.id),
      draftId,
    );
    if (!hasExplicitComposerModelSelection(currentDraft)) {
      applyStickyState(draftId);
      const environmentSettings = environments.find(
        (environment) => environment.environmentId === project.environmentId,
      )?.serverConfig?.settings;
      const defaultModelSelection = environmentSettings
        ? resolveProjectSettings(environmentSettings, project.id, project).settings
            .defaultModelSelection
        : project.defaultModelSelection;
      if (defaultModelSelection) {
        setModelSelection(draftId, defaultModelSelection, {
          replaceOptions: true,
        });
      }
    }
  };
  /** Retargets the open draft to a new idea or to the host scratch project. */
  const startWithoutProject = async (kind: NoProjectKind): Promise<boolean> => {
    const environmentId = kind === "idea" ? noProjectEnvironmentId : scratchTargetEnvironmentId;
    if (environmentId === null || (kind === "idea" ? isIdeaDraft : isScratchDraft)) {
      return false;
    }
    const requested = { draftId, activeProjectKey, scratchTargetEnvironmentId };
    const project = await (kind === "idea"
      ? openIdeaProject(environmentId)
      : openScratchProject(environmentId));
    const latest = latestTargetRef.current;
    if (
      !project ||
      latest.draftId !== requested.draftId ||
      latest.activeProjectKey !== requested.activeProjectKey ||
      latest.scratchTargetEnvironmentId !== requested.scratchTargetEnvironmentId
    ) {
      return false;
    }
    selectProject(project, deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings));
    return true;
  };

  const projectSelector = shouldShowProjectMenu ? (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            // The trigger's accessible name comes from its visible text (the
            // project title) so the hero sentence reads naturally: an
            // aria-label here would replace the title with an action phrase
            // mid-sentence and baffle screen-reader users.
            <MenuTrigger
              render={<InlineButton tone="picker" />}
              data-draft-project-trigger=""
              className="pointer-events-auto max-w-64 align-baseline"
            />
          }
        >
          <span className="min-w-0 truncate">
            {isIdeaDraft
              ? "New idea"
              : isScratchDraft
                ? scratchLabel
                : (activeProjectDisplayName ?? "Choose a project")}
          </span>
        </TooltipTrigger>
        {activeProjectDisplayName && !isNoProjectDraft ? (
          <TooltipPopup side="top">{activeProjectDisplayName}</TooltipPopup>
        ) : null}
      </Tooltip>
      <MenuPopup align="center" className="max-h-80 overflow-y-auto">
        <MenuRadioGroup
          value={
            isIdeaDraft ? NEW_IDEA_VALUE : isScratchDraft ? NO_PROJECT_VALUE : activeProjectKey
          }
          onValueChange={(value) => {
            if (value === NEW_IDEA_VALUE || value === NO_PROJECT_VALUE) {
              void startWithoutProject(value === NEW_IDEA_VALUE ? "idea" : "scratch");
              return;
            }
            const entry = projectEntryByKey.get(value as string);
            if (!entry || value === activeProjectKey) {
              return;
            }
            selectProject(entry.targetProject, entry.group.projectKey);
          }}
        >
          {ideasOffered || isIdeaDraft ? (
            <MenuRadioItem value={NEW_IDEA_VALUE} closeOnClick>
              <span className="flex min-w-0 items-center gap-2">
                <span
                  aria-hidden="true"
                  className={`inline-flex size-4 shrink-0 ${projectIconColorClassName("gray")}`}
                >
                  <LightbulbIcon className="size-full" />
                </span>
                New idea
              </span>
            </MenuRadioItem>
          ) : null}
          {scratchWorkspaceRoot === null ? null : (
            <MenuRadioItem value={NO_PROJECT_VALUE} closeOnClick>
              <span className="flex min-w-0 items-center gap-2">
                {/* Boxed like ProjectFavicon so the label lines up with project rows. */}
                <span
                  aria-hidden="true"
                  className={`inline-flex size-4 shrink-0 ${projectIconColorClassName("gray")}`}
                >
                  <MessageSquareDashedIcon className="size-full" />
                </span>
                {scratchLabel}
              </span>
            </MenuRadioItem>
          )}
          {menuEntries.map(({ group }) => {
            return (
              <MenuRadioItem key={group.projectKey} value={group.projectKey} closeOnClick>
                <span className="flex min-w-0 items-center gap-2">
                  <ProjectFavicon project={group} className="size-4 shrink-0" />
                  <Tooltip>
                    <TooltipTrigger render={<span className="block min-w-0 truncate" />}>
                      {group.displayName}
                    </TooltipTrigger>
                    <TooltipPopup side="top">{group.displayName}</TooltipPopup>
                  </Tooltip>
                  {showProjectEnvironments ? (
                    <ProjectEnvironmentBadge
                      group={group}
                      primaryEnvironmentId={primaryEnvironmentId}
                      machineByEnvironmentId={environmentMachineById}
                    />
                  ) : null}
                </span>
              </MenuRadioItem>
            );
          })}
        </MenuRadioGroup>
        {projectPickerEntries.length > 0 ? <MenuSeparator /> : null}
        <MenuItem onClick={openAddProject}>
          <FolderPlusIcon />
          Add project
        </MenuItem>
      </MenuPopup>
    </Menu>
  ) : (
    <button
      type="button"
      onClick={openAddProject}
      className="pointer-events-auto inline cursor-pointer border-muted-foreground/35 border-b border-dotted text-muted-foreground/60 transition-colors hover:border-muted-foreground/60 hover:text-muted-foreground/80 focus-visible:rounded-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
    >
      {activeProjectTitle ?? "Add a project"}
    </button>
  );

  // The composer hero is a sentence, so the heading's accessible name must be
  // a complete sentence too. The project picker is a control rendered inline
  // in the h1; without an explicit label its widget state bleeds into the
  // announced phrase.
  const headingLabel = isNoProjectDraft
    ? "What should we work on?"
    : hasResolvedProject
      ? `What should we build in ${activeProjectDisplayName}?`
      : canChooseProject
        ? `${activeProjectDisplayName ?? "Choose a project"} to start`
        : "Add a project to start";

  // One click out of the project, phrased as the alternative to the question
  // above it. Focus moves to the project picker once this line has gone.
  const noProjectShortcut = shortcutLabelForCommand(keybindings, "chat.newWithoutProject");
  const orStartWithoutProject =
    withoutProject !== null && !isNoProjectDraft && (hasResolvedProject || canChooseProject) ? (
      <Tooltip>
        <TooltipTrigger
          render={
            <InlineButton
              tone="muted"
              className="pointer-events-auto"
              onClick={() =>
                void startWithoutProject(withoutProject).then((started) => {
                  if (started) {
                    document.querySelector<HTMLElement>("[data-draft-project-trigger]")?.focus();
                  }
                })
              }
            />
          }
        >
          or start without a project
        </TooltipTrigger>
        {noProjectShortcut ? <TooltipPopup side="bottom">{noProjectShortcut}</TooltipPopup> : null}
      </Tooltip>
    ) : null;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col items-center">
      <h1
        aria-label={headingLabel}
        className="w-full text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl"
      >
        {isNoProjectDraft ? (
          <>What should we work on?</>
        ) : hasResolvedProject ? (
          <>What should we build in {projectSelector}?</>
        ) : canChooseProject ? (
          <>{projectSelector} to start</>
        ) : (
          <>Add a project to start</>
        )}
      </h1>
      {/* Reserved whenever threads can skip a project, so the heading does not
          move. Without a project, the picker moves here to choose one. */}
      {withoutProject === null && !isNoProjectDraft ? null : (
        <p className="mt-2 flex h-6 items-center text-sm">
          {isNoProjectDraft ? projectSelector : orStartWithoutProject}
        </p>
      )}
    </div>
  );
}
