import type { EnvironmentId } from "@t3tools/contracts";
import { SproutIcon } from "lucide-react";

import { useTrellisRoot } from "~/hooks/useTrellis";
import { isTrellisWorkspaceRoot } from "~/lib/trellis";
import type { SidebarProjectSnapshot } from "~/sidebarProjectGrouping";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

type MemberProject = SidebarProjectSnapshot["memberProjects"][number];

/**
 * Marks a project picker row whose group has a member in a Trellis workspace
 * of that member's environment. Renders nothing where Trellis is unavailable.
 */
export function TrellisWorkspaceBadge(props: {
  readonly group: Pick<SidebarProjectSnapshot, "memberProjects">;
}) {
  const environmentIds = [
    ...new Set(props.group.memberProjects.map((member) => member.environmentId)),
  ];
  return (
    <TrellisEnvironmentCheck environmentIds={environmentIds} members={props.group.memberProjects} />
  );
}

/**
 * Checks the group's environments one per component, so each can query its
 * own Trellis status, and renders at most one badge.
 */
function TrellisEnvironmentCheck(props: {
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly members: ReadonlyArray<MemberProject>;
}) {
  const [environmentId = null, ...rest] = props.environmentIds;
  const root = useTrellisRoot(environmentId);
  if (environmentId === null) return null;
  const matches = props.members.some(
    (member) =>
      member.environmentId === environmentId && isTrellisWorkspaceRoot(member.workspaceRoot, root),
  );
  if (!matches) {
    return rest.length > 0 ? (
      <TrellisEnvironmentCheck environmentIds={rest} members={props.members} />
    ) : null;
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label="Trellis workspace"
            className="inline-flex shrink-0 items-center text-muted-foreground"
          />
        }
      >
        <SproutIcon aria-hidden className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">Trellis workspace</TooltipPopup>
    </Tooltip>
  );
}
