import type { EnvironmentId, ProjectId, TrellisWorkspaceEntry } from "@t3tools/contracts";
import { AlertTriangleIcon, BotIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { useEnvironmentQuery } from "~/state/query";
import { trellisEnvironment } from "~/state/trellis";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import {
  type TrellisProfileGroup,
  trellisProfileErrorText,
  trellisProfileFreshness,
  trellisProfileGroups,
  trellisProfileLooseErrors,
} from "./TrellisProfile.logic";

type ProviderName = "claude" | "codex";

const PROVIDERS: ReadonlyArray<{ readonly value: ProviderName; readonly label: string }> = [
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
];

const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const formatUnixTime = (seconds: number) => timeFormat.format(new Date(seconds * 1000));

/**
 * The effective agent profile from Trellis, read only: per provider the MCP
 * servers, skills and instructions with the layer each comes from and its
 * state, and the profile's errors. Without a `target` it shows the agent
 * homes and the global layer (Settings → Trellis); with a workspace it adds
 * the project and workspace layers, the repository's own files and T3's server.
 */
export function TrellisProfileSection(props: {
  readonly environmentId: EnvironmentId;
  readonly target: string | null;
  readonly id?: string | undefined;
  readonly description: string;
  /** Above the profile, e.g. a workspace picker. */
  readonly picker?: ReactNode;
}) {
  const { environmentId, target } = props;
  const query = useEnvironmentQuery(
    trellisEnvironment.profile({
      environmentId,
      input: target === null ? {} : { target },
    }),
  );
  const [providerName, setProviderName] = useState<ProviderName>("claude");
  const profile = query.data;
  const provider = profile?.providers[providerName] ?? null;
  const groups =
    provider === null ? [] : trellisProfileGroups(provider, { withT3Server: target !== null });
  const freshness = profile ? trellisProfileFreshness(profile, formatUnixTime) : null;
  const errors = profile ? trellisProfileLooseErrors(profile) : [];

  return (
    <SettingsSection
      {...(props.id === undefined ? {} : { id: props.id })}
      title="Agent profile"
      icon={<BotIcon className="size-3.5" />}
      headerAction={
        <span className="inline-flex items-center gap-2">
          <ToggleGroup
            aria-label="Provider"
            variant="segmented"
            value={[providerName]}
            onValueChange={(next) => {
              const value = PROVIDERS.find((entry) => entry.value === next[0])?.value;
              if (value !== undefined) setProviderName(value);
            }}
          >
            {PROVIDERS.map((entry) => (
              <Toggle key={entry.value} value={entry.value}>
                {entry.label}
              </Toggle>
            ))}
          </ToggleGroup>
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label="Refresh the agent profile"
            disabled={query.isPending}
            onClick={() => query.refresh()}
          >
            <RefreshIcon refreshing={query.isPending} />
          </Button>
        </span>
      }
    >
      {props.picker}
      {profile == null ? (
        <SettingsRow
          title={
            <span className="inline-flex items-center gap-2">
              {query.isPending ? <Spinner size="sm" tone="muted" /> : null}
              {query.isPending ? "Reading the profile" : "Could not read the profile"}
            </span>
          }
          description={query.error ?? undefined}
        />
      ) : (
        <>
          <SettingsRow
            title={target === null ? "Agent homes and global layer" : "Effective profile"}
            description={props.description}
            status={
              freshness === null ? undefined : freshness.warning ? (
                <WarningText>{freshness.text}</WarningText>
              ) : (
                freshness.text
              )
            }
            control={
              profile.trusted === null ? undefined : (
                <Badge variant={profile.trusted ? "success" : "warning"}>
                  {profile.trusted ? "Trusted project" : "Untrusted project"}
                </Badge>
              )
            }
          />
          {errors.length === 0 ? null : (
            <SettingsRow
              title={<WarningText>Profile errors</WarningText>}
              description="Problems Trellis found in the layers. Affected items are left out."
              status={errors.map((entry, index) => (
                // Errors carry no id; the same layer and item can repeat.
                // oxlint-disable-next-line react/no-array-index-key
                <span key={index} className="block break-words font-mono">
                  {trellisProfileErrorText(entry)}
                </span>
              ))}
            />
          )}
          {provider === null ? (
            <SettingsRow
              title="Not reported"
              description="This Trellis reports no profile for this provider."
            />
          ) : (
            groups.map((group) => <ProfileGroupRow key={group.key} group={group} />)
          )}
        </>
      )}
    </SettingsSection>
  );
}

function ProfileGroupRow({ group }: { readonly group: TrellisProfileGroup }) {
  return (
    <SettingsRow
      title={group.title}
      control={<span className="text-muted-foreground text-xs">{group.rows.length}</span>}
    >
      {group.rows.length === 0 ? (
        <p className="pb-2 text-muted-foreground text-xs">None</p>
      ) : (
        <ul className="divide-y divide-border/60 pb-1">
          {group.rows.map((row) => (
            <li key={row.key} className={row.off ? "py-1.5 opacity-60" : "py-1.5"}>
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <span className="truncate font-mono text-xs">{row.name}</span>
                <span className="shrink-0 text-muted-foreground text-xs">{row.source}</span>
                {row.badges.map((badge) => (
                  <Badge
                    key={badge.label}
                    size="sm"
                    variant={badge.tone}
                    {...(badge.hint === null ? {} : { title: badge.hint })}
                  >
                    {badge.label}
                  </Badge>
                ))}
              </div>
              {row.detail === null ? null : (
                <p className="truncate text-muted-foreground text-xs">{row.detail}</p>
              )}
              {row.error === null ? null : (
                <p className="break-words text-destructive-foreground text-xs">{row.error}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </SettingsRow>
  );
}

function WarningText({ children }: { readonly children: ReactNode }) {
  return (
    <span className="inline-flex items-start gap-1.5">
      <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />
      <span>{children}</span>
    </span>
  );
}

/** The live workspaces of a project whose profile can be shown, its own first. */
function profileWorkspaces(
  items: ReadonlyArray<TrellisWorkspaceEntry>,
  projectId: ProjectId,
): ReadonlyArray<TrellisWorkspaceEntry> {
  const live = items.filter((entry) => entry.state !== "discarded");
  return [
    ...live.filter((entry) => entry.projectId === projectId),
    ...live.filter((entry) => entry.projectId !== projectId),
  ];
}

/**
 * A Trellis project's agent profile, per workspace: this project's own
 * workspace by default, any live fork on choice.
 */
export function TrellisProjectProfileSection(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const { environmentId, projectId } = props;
  const workspacesQuery = useEnvironmentQuery(
    trellisEnvironment.workspaces({ environmentId, input: { projectId } }),
  );
  const [chosen, setChosen] = useState<string | null>(null);
  if (workspacesQuery.data?.trellisProjectId == null) return null;
  const workspaces = profileWorkspaces(workspacesQuery.data.items, projectId);
  const target = workspaces.find((entry) => entry.id === chosen)?.id ?? workspaces[0]?.id ?? null;
  if (target === null) return null;
  const nameOf = (id: string | null) => workspaces.find((entry) => entry.id === id)?.name ?? id;

  return (
    <TrellisProfileSection
      environmentId={environmentId}
      target={target}
      description="What each provider gets in this workspace, layer by layer. T3 adds its own server to every session."
      picker={
        workspaces.length < 2 ? undefined : (
          <SettingsRow
            title="Workspace"
            control={
              <Select value={target} onValueChange={(value) => value && setChosen(value)}>
                <SelectTrigger size="sm" aria-label="Workspace">
                  <SelectValue>{(value: string | null) => nameOf(value)}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {workspaces.map((entry) => (
                    <SelectItem key={entry.id} value={entry.id}>
                      {entry.projectId === projectId ? `${entry.name} (this one)` : entry.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        )
      }
    />
  );
}
