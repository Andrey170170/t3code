import type { EnvironmentId } from "@t3tools/contracts";
import { SproutIcon } from "lucide-react";

import { isTrellisWorkspaceRoot } from "~/lib/trellis";
import type { SidebarProjectSnapshot } from "~/sidebarProjectGrouping";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Marks a project picker row whose group has a member in a Trellis workspace
 * of the Trellis environment. Renders nothing when Trellis is unavailable.
 */
export function TrellisWorkspaceBadge(props: {
  readonly group: Pick<SidebarProjectSnapshot, "memberProjects">;
  readonly trellis: { readonly environmentId: EnvironmentId; readonly root: string | null } | null;
}) {
  const { trellis } = props;
  if (
    trellis === null ||
    !props.group.memberProjects.some(
      (member) =>
        member.environmentId === trellis.environmentId &&
        isTrellisWorkspaceRoot(member.workspaceRoot, trellis.root),
    )
  ) {
    return null;
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
