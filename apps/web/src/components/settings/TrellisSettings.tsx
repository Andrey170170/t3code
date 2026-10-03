import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, TrellisDetails, TrellisTrashItem } from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/usageLimits";
import {
  ActivityIcon,
  AlertTriangleIcon,
  BoxesIcon,
  HistoryIcon,
  GlobeIcon,
  LightbulbIcon,
  SproutIcon,
  TrashIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { useTrellisStatusFor } from "../../hooks/useTrellis";
import { cn } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { refreshTrellisStatus, trellisEnvironment } from "../../state/trellis";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { RefreshIcon } from "../ui/refresh-icon";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  baseStateView,
  type PreviewHostChoice,
  previewHostChoice,
  previewHostSetting,
  formatBytes,
  finishHistoryWrite,
  HISTORY_SETTINGS,
  type HistoryEdits,
  type HistoryKey,
  historyDefaultNote,
  historyEdit,
  historyFieldValue,
  historyValuesInForce,
  NO_HISTORY_EDITS,
  rejectHistoryEdit,
  startHistoryWrite,
  lastThinningText,
  snapshotCountsText,
  staleDetailsNotice,
  trellisVersionText,
  wouldRemoveText,
  workspaceLabel,
} from "./TrellisSettings.logic";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import { useSettingsScope } from "./SettingsScopeContext";

function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0], fallback: string) {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const formatDay = (unixSeconds: number) => dateFormat.format(new Date(unixSeconds * 1000));
const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const formatTime = (unixSeconds: number) => timeFormat.format(new Date(unixSeconds * 1000));

/** When a trashed item goes away for good, in words. */
function trashExpiryText(item: Pick<TrellisTrashItem, "expiresAt" | "unmerged">): string {
  return item.expiresAt === null
    ? item.unmerged === true
      ? "Kept until purged"
      : "Kept until you empty the trash"
    : `Removed for good on ${formatDay(item.expiresAt)}`;
}

/** A discarded fork's unmerged work and any purge request, in words; null when neither. */
function trashItemNotes(
  item: Pick<TrellisTrashItem, "unmerged" | "unmergedReason" | "purgeRequested">,
): string | null {
  const notes: Array<string> = [];
  if (item.unmerged === true) {
    notes.push(`Unmerged work${item.unmergedReason ? `: ${item.unmergedReason}` : ""}`);
  } else if (item.unmerged === false) {
    notes.push("Nothing unmerged");
  }
  if (item.purgeRequested != null) {
    const by = item.purgeRequested.by === null ? "An agent" : `"${item.purgeRequested.by}"`;
    notes.push(
      `${by} asked to purge it${item.purgeRequested.reason ? `: ${item.purgeRequested.reason}` : ""}`,
    );
  }
  return notes.length === 0 ? null : notes.join(" · ");
}

/** A search anchor id as a prop, or none. */
const idProp = (id: string | undefined) => (id === undefined ? {} : { id });

const KIND_LABELS: Readonly<Record<TrellisTrashItem["kind"], string>> = {
  idea: "Idea",
  project: "Project",
  workspace: "Fork",
};

/**
 * Trellis settings of each selected environment: the integration switch, the
 * service's status, its bases, its history settings, and the Trellis trash
 * with restore. Each topic is its own section, so more slot in beside them.
 */
export function TrellisSettingsPanel() {
  const { connectedEnvironments, scope } = useSettingsScope();
  if (scope.kind === "project" || scope.kind === "checkout") {
    return (
      <SettingsScopeNotice target="environment">
        Trellis is set up per environment. Choose an environment to change it.
      </SettingsScopeNotice>
    );
  }
  return (
    <SettingsPageContainer>
      {connectedEnvironments.length === 0 ? (
        <SettingsSection {...searchableSetting("trellis-integration")}>
          <SettingsRow
            title="No connected environment"
            description="Connect to an environment to set up Trellis on it."
          />
        </SettingsSection>
      ) : (
        connectedEnvironments.map((environment, index) => (
          <TrellisEnvironmentSettings
            key={environment.environmentId}
            environmentId={environment.environmentId}
            label={connectedEnvironments.length > 1 ? environment.label : null}
            enabled={environment.serverConfig?.settings.trellis?.enabled === true}
            anchors={index === 0}
          />
        ))
      )}
    </SettingsPageContainer>
  );
}

function TrellisEnvironmentSettings(props: {
  readonly environmentId: EnvironmentId;
  /** Shown above the environment's sections when several are selected. */
  readonly label: string | null;
  readonly enabled: boolean;
  /** The first environment carries the search anchors. */
  readonly anchors: boolean;
}) {
  const { environmentId, label, enabled } = props;
  const statusQuery = useEnvironmentQuery(trellisEnvironment.status({ environmentId, input: {} }));
  const status = useTrellisStatusFor(environmentId);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });
  const [saving, setSaving] = useState(false);
  const anchor = (id: Parameters<typeof searchableSetting>[0]) =>
    props.anchors ? searchableSetting(id).id : undefined;

  const setEnabled = async (next: boolean) => {
    setSaving(true);
    try {
      const result = await updateSettings({
        environmentId,
        input: { patch: { trellis: { enabled: next } } },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          toastManager.add({
            type: "error",
            title: "Trellis setting not saved",
            description: failureMessage(result, "The environment did not respond."),
          });
        }
        return;
      }
      statusQuery.refresh();
    } finally {
      setSaving(false);
    }
  };

  // The switch is the source of truth; the status query may lag behind it.
  const state = !enabled ? "disabled" : (status?.state ?? "unavailable");
  const socketPath = statusQuery.data?.socketPath ?? null;
  const statusText =
    state === "disabled"
      ? "Off. Existing Trellis projects keep their conversations, but their agents do not run."
      : state === "ready"
        ? `Connected${status?.root ? ` · workspaces in ${status.root}` : ""}.`
        : `On, but Trellis is not answering${socketPath ? ` at ${socketPath}` : ""}. Start it with \`trellis serve\`.`;

  return (
    <>
      {label === null ? null : (
        <h2 className="px-3 pt-2 text-base font-medium text-foreground sm:px-4">{label}</h2>
      )}
      <SettingsSection
        {...idProp(anchor("trellis-integration"))}
        title="Trellis"
        icon={<SproutIcon className="size-3.5" />}
      >
        <SettingsRow
          title="Use Trellis workspaces"
          description="Ideas and Trellis projects run in isolated workspaces with snapshots."
          status={statusText}
          control={
            <Switch
              aria-label="Use Trellis workspaces"
              checked={enabled}
              disabled={saving}
              onCheckedChange={(checked) => void setEnabled(Boolean(checked))}
            />
          }
        />
      </SettingsSection>
      {state === "ready" ? (
        <>
          <TrellisDetailsSections
            environmentId={environmentId}
            statusId={anchor("trellis-status")}
            basesId={anchor("trellis-bases")}
          />
          <TrellisHistorySection environmentId={environmentId} id={anchor("trellis-history")} />
          <TrellisTrashSection
            environmentId={environmentId}
            title="Trash"
            id={anchor("trellis-trash")}
          />
        </>
      ) : null}
    </>
  );
}

/** A read-only value in a settings row's control slot. */
function Value(props: { readonly children: ReactNode; readonly mono?: boolean }) {
  return (
    <span
      className={cn(
        "min-w-0 truncate text-sm text-muted-foreground @min-[32rem]/settings-row:text-right",
        props.mono === true && "font-mono text-xs",
      )}
    >
      {props.children}
    </span>
  );
}

const UNKNOWN = "Not reported";

/**
 * The service's status and bases, from one `/v1/status` read. Older Trellis
 * versions report little beyond the root; their rows read "Not reported".
 * Where previews listen shows once Trellis reports it.
 */
function TrellisDetailsSections(props: {
  readonly environmentId: EnvironmentId;
  readonly statusId: string | undefined;
  readonly basesId: string | undefined;
}) {
  const { environmentId } = props;
  const detailsQuery = useEnvironmentQuery(
    trellisEnvironment.details({ environmentId, input: {} }),
  );
  const details = detailsQuery.data;
  const refreshing = detailsQuery.isPending;
  // A failed refresh keeps the last details; they must not look current.
  const staleNotice = staleDetailsNotice({
    hasData: details !== null,
    error: detailsQuery.error,
    updatedAt: detailsQuery.dataUpdatedAt,
  });

  const refresh = () => {
    detailsQuery.refresh();
    refreshTrellisStatus(appAtomRegistry, environmentId);
  };

  return (
    <>
      <SettingsSection
        {...idProp(props.statusId)}
        title="Service"
        icon={<ActivityIcon className="size-3.5" />}
        headerAction={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label="Refresh Trellis status"
            disabled={refreshing}
            onClick={refresh}
          >
            <RefreshIcon refreshing={refreshing} />
          </Button>
        }
      >
        {details === null ? (
          <SettingsRow
            title={
              <span className="inline-flex items-center gap-2">
                {refreshing ? <Spinner size="sm" tone="muted" /> : null}
                {refreshing ? "Asking Trellis" : "Could not read the Trellis status"}
              </span>
            }
            description={detailsQuery.error ?? undefined}
          />
        ) : (
          <>
            {staleNotice === null ? null : (
              <SettingsRow
                title={<WarningTitle>Status may be out of date</WarningTitle>}
                description={staleNotice}
              />
            )}
            <TrellisStatusRows details={details} />
          </>
        )}
      </SettingsSection>
      {details === null ? null : (
        <SettingsSection
          {...idProp(props.basesId)}
          title="Bases"
          icon={<BoxesIcon className="size-3.5" />}
        >
          <TrellisBaseRows
            environmentId={environmentId}
            bases={details.bases}
            baseStates={details.baseStates}
            buildingBases={details.buildingBases}
            baseBuildFailures={details.baseBuildFailures}
            defaultBase={details.defaultBase}
            onBuilt={refresh}
          />
        </SettingsSection>
      )}
      {details?.previewHost == null ? null : (
        <SettingsSection title="Previews" icon={<GlobeIcon className="size-3.5" />}>
          <TrellisPreviewHostRow
            environmentId={environmentId}
            previewHost={details.previewHost}
            onChanged={refresh}
          />
        </SettingsSection>
      )}
    </>
  );
}

function TrellisStatusRows({ details }: { readonly details: TrellisDetails }) {
  const running = details.runningWorkspaces;
  const restartNeeded = details.restartNeeded ?? [];
  const homes = details.agentHomes;
  return (
    <>
      <SettingsRow
        title="Version"
        control={
          trellisVersionText(details) === null ? (
            <Value>{UNKNOWN}</Value>
          ) : (
            <Value mono>{trellisVersionText(details)}</Value>
          )
        }
      />
      <SettingsRow
        title="Uptime"
        control={
          <Value>
            {details.uptimeSecs === null ? UNKNOWN : formatDuration(details.uptimeSecs * 1000)}
          </Value>
        }
      />
      <SettingsRow
        title="Free space"
        control={
          <Value>
            {details.disk === null
              ? UNKNOWN
              : `${formatBytes(details.disk.freeBytes)} of ${formatBytes(details.disk.totalBytes)}`}
          </Value>
        }
      />
      <SettingsRow
        title="Running workspaces"
        description={
          running === null || running.length === 0
            ? undefined
            : running.map(workspaceLabel).join(", ")
        }
        control={
          <Value>
            {running === null ? "Unknown" : running.length === 0 ? "None" : running.length}
          </Value>
        }
      />
      {restartNeeded.length === 0 ? null : (
        <SettingsRow
          title={<WarningTitle>Workspaces needing a restart</WarningTitle>}
          description="They run with an older mount layout or Trellis binary until they restart."
          status={restartNeeded.map((entry) => (
            <span key={entry.id} className="block">
              {`${workspaceLabel(entry)}: ${entry.reason}`}
            </span>
          ))}
          control={<Value>{restartNeeded.length}</Value>}
        />
      )}
      {details.missingProviders.length === 0 ? null : (
        <SettingsRow
          title={<WarningTitle>Missing providers</WarningTitle>}
          description="Not found on the Trellis service's PATH, so they cannot run in workspaces."
          control={<Value mono>{details.missingProviders.join(", ")}</Value>}
        />
      )}
      {details.pendingOperations.length === 0 ? null : (
        <SettingsRow
          title={<WarningTitle>Unfinished operations</WarningTitle>}
          description="Journaled operations an interruption left unfinished."
          status={details.pendingOperations
            .map((operation) =>
              operation.target === null ? operation.kind : `${operation.kind} ${operation.target}`,
            )
            .join(", ")}
          control={<Value>{details.pendingOperations.length}</Value>}
        />
      )}
      <SettingsRow
        title="Agent homes"
        description={homes === null ? undefined : "Provider homes mounted into workspaces."}
        status={
          homes === null ? undefined : (
            <>
              <span className="block font-mono">Claude: {homes.claude ?? "not mounted"}</span>
              <span className="block font-mono">Codex: {homes.codex ?? "not mounted"}</span>
            </>
          )
        }
        control={homes === null ? <Value>{UNKNOWN}</Value> : undefined}
      />
    </>
  );
}

function WarningTitle({ children }: { readonly children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <AlertTriangleIcon className="size-3.5 shrink-0 text-warning" />
      {children}
    </span>
  );
}

const PREVIEW_HOST_CHOICES: ReadonlyArray<{ value: PreviewHostChoice; label: string }> = [
  { value: "local", label: "This machine" },
  { value: "lan", label: "Local network" },
  { value: "tailscale", label: "Tailnet" },
  { value: "custom", label: "Address…" },
];

/**
 * Where previews of workspace ports listen. Changing it binds every open
 * preview again at the new address, under the same ports.
 */
function TrellisPreviewHostRow(props: {
  readonly environmentId: EnvironmentId;
  readonly previewHost: NonNullable<TrellisDetails["previewHost"]>;
  readonly onChanged: () => void;
}) {
  const { environmentId } = props;
  const setHost = useAtomCommand(trellisEnvironment.setPreviewHost, { reportFailure: false });
  // The setting in force: the last read, or a save's answer until the next
  // read, which also brings changes made elsewhere (the CLI, another client).
  const [committed, setCommitted] = useState(props.previewHost);
  // Keyed on the values, so a refresh repeating the last read keeps a newer save's answer.
  const { setting: readSetting, bind: readBind, urlHost: readUrlHost } = props.previewHost;
  useEffect(
    () => setCommitted({ setting: readSetting, bind: readBind, urlHost: readUrlHost }),
    [readSetting, readBind, readUrlHost],
  );
  // Local edits not saved yet; null follows the setting in force.
  const [draftChoice, setDraftChoice] = useState<PreviewHostChoice | null>(null);
  const [draftAddress, setDraftAddress] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const committedChoice = previewHostChoice(committed.setting);
  const choice = draftChoice ?? committedChoice;
  const address = draftAddress ?? (committedChoice === "custom" ? committed.setting : "");
  const save = async (next: PreviewHostChoice, typed: string) => {
    const setting = previewHostSetting(next, typed);
    if (setting === null) return;
    if (setting === committed.setting) {
      setDraftChoice(null);
      setDraftAddress(null);
      return;
    }
    setPending(true);
    try {
      const result = await setHost({ environmentId, input: { previewHost: setting } });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          toastManager.add({
            type: "error",
            title: "Could not change where previews listen",
            description: failureMessage(result, "Trellis did not respond."),
          });
        }
        return;
      }
      setCommitted(result.value.previewHost);
      const { errors } = result.value;
      toastManager.add(
        errors.length === 0
          ? {
              type: "success",
              title: `Previews now listen on ${result.value.previewHost.bind}`,
              description: "Previews already open keep their old address: open them again.",
            }
          : {
              type: "warning",
              title: `${errors.length} preview${errors.length === 1 ? "" : "s"} could not move`,
              description: errors
                .map((error) => `${error.workspace} port ${error.port}: ${error.error}`)
                .join("\n"),
            },
      );
    } finally {
      // Saved or refused, the row shows the setting in force again.
      setDraftChoice(null);
      setDraftAddress(null);
      setPending(false);
      props.onChanged();
    }
  };
  return (
    <SettingsRow
      title="Preview address"
      description={`Where previews of workspace ports listen: ${committed.bind}, opened as ${committed.urlHost}. This machine keeps them private. The local network or the tailnet lets other devices open them, with no T3 sign-in in front: anyone who reaches the address reaches the workspace's server.`}
      control={
        <span className="inline-flex items-center gap-2">
          {choice === "custom" ? (
            <Input
              size="sm"
              className="w-36"
              aria-label="Preview address"
              placeholder="IP address"
              value={address}
              disabled={pending}
              onChange={(event) => setDraftAddress(event.target.value)}
              onBlur={() => {
                // Only a typed address is saved; an untouched one follows the setting.
                if (draftAddress !== null) void save("custom", draftAddress);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
          ) : null}
          <Select
            items={PREVIEW_HOST_CHOICES}
            value={choice}
            disabled={pending}
            onValueChange={(value) => {
              if (value === null) return;
              if (value === "custom") setDraftChoice("custom");
              else void save(value, "");
            }}
          >
            <SelectTrigger size="xs" className="w-36" aria-label="Where previews listen">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {PREVIEW_HOST_CHOICES.map(({ value, label }) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </span>
      }
    />
  );
}

function TrellisBaseRows(props: {
  readonly environmentId: EnvironmentId;
  readonly bases: ReadonlyArray<string>;
  readonly baseStates: TrellisDetails["baseStates"];
  /** Builds the server runs, also ones started before this page opened. */
  readonly buildingBases: ReadonlyArray<string>;
  readonly baseBuildFailures: TrellisDetails["baseBuildFailures"];
  readonly defaultBase: string | null;
  readonly onBuilt: () => void;
}) {
  const { environmentId, bases, defaultBase } = props;
  const defaultMissing = defaultBase !== null && !bases.includes(defaultBase);
  const buildBase = useAtomCommand(trellisEnvironment.buildBase, { reportFailure: false });
  // One build at a time per root, as Trellis allows; the server joins a
  // repeated request for the same base to the running build.
  const [startedHere, setStartedHere] = useState<string | null>(null);
  const building = startedHere ?? props.buildingBases[0] ?? null;
  const rebuild = async (base: string) => {
    setStartedHere(base);
    try {
      const result = await buildBase({ environmentId, input: { name: base } });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          toastManager.add({
            type: "error",
            title: `Could not rebuild ${base}`,
            description: failureMessage(result, "Trellis did not respond."),
          });
        }
        return;
      }
      toastManager.add({
        type: "success",
        title: `Rebuilt ${base}`,
        description: "New workspaces start from it; existing ones keep their environment.",
      });
    } finally {
      setStartedHere(null);
      props.onBuilt();
    }
  };
  return (
    <>
      {bases.length === 0 && !defaultMissing ? <SettingsRow title="No bases reported" /> : null}
      {bases.map((base) => {
        const state = baseStateView(props.baseStates?.[base] ?? null);
        const failure = props.baseBuildFailures[base];
        const description = [
          base === defaultBase ? "New projects start from this base." : null,
          failure === undefined ? state.description : `The last rebuild failed: ${failure}`,
        ]
          .filter((line) => line !== null)
          .join(" ");
        return (
          <SettingsRow
            key={base}
            title={
              state.warn || failure !== undefined ? (
                <WarningTitle>
                  <span className="font-mono">{base}</span>
                </WarningTitle>
              ) : (
                <span className="font-mono">{base}</span>
              )
            }
            description={description.length > 0 ? description : undefined}
            control={
              <span className="inline-flex items-center gap-2">
                {base === defaultBase ? (
                  <Badge variant="secondary" size="sm">
                    Default
                  </Badge>
                ) : null}
                {/* `base_states` came with the build endpoint: a Trellis without them cannot build. */}
                {state.rebuildable && props.baseStates !== null ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={building !== null}
                    title="Builds it again from its definition; takes a few minutes."
                    onClick={() => void rebuild(base)}
                  >
                    {building === base ? <Spinner size="sm" tone="muted" /> : null}
                    {building === base ? "Rebuilding…" : "Rebuild"}
                  </Button>
                ) : null}
              </span>
            }
          />
        );
      })}
      {defaultMissing ? (
        <SettingsRow
          title={
            <WarningTitle>
              <span className="font-mono">{defaultBase}</span>
            </WarningTitle>
          }
          description="The default base is not built, so new projects cannot start from it."
          control={
            <Badge variant="warning" size="sm">
              Default
            </Badge>
          }
        />
      ) : null}
    </>
  );
}

function TrellisTrashSection(props: {
  readonly environmentId: EnvironmentId;
  readonly title: string;
  readonly id: string | undefined;
}) {
  const { environmentId } = props;
  const trashQuery = useEnvironmentQuery(trellisEnvironment.trash({ environmentId, input: {} }));
  const restore = useAtomCommand(trellisEnvironment.restore, { reportFailure: false });
  const emptyTrash = useAtomCommand(trellisEnvironment.emptyTrash, { reportFailure: false });
  const purge = useAtomCommand(trellisEnvironment.purge, { reportFailure: false });
  const [pending, setPending] = useState<string | null>(null);
  const items = trashQuery.data?.items ?? [];

  const restoreItem = async (item: TrellisTrashItem) => {
    setPending(item.id);
    try {
      const result = await restore({ environmentId, input: { kind: item.kind, id: item.id } });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          toastManager.add({
            type: "error",
            title: `Could not restore ${item.name}`,
            description: failureMessage(result, "Trellis did not respond."),
          });
        }
        return;
      }
      toastManager.add({ type: "success", title: `Restored ${item.name}` });
      refreshTrellisStatus(appAtomRegistry, environmentId);
    } finally {
      setPending(null);
      trashQuery.refresh();
    }
  };

  // Confirms an agent's purge request: only the user purges.
  const purgeItem = async (item: TrellisTrashItem) => {
    const api = readLocalApi();
    if (!api) return;
    const confirmed = await api.dialogs.confirm(
      [
        `Purge ${KIND_LABELS[item.kind].toLowerCase()} "${item.name}" for good?`,
        item.unmerged === true
          ? `It holds unmerged work${item.unmergedReason ? ` (${item.unmergedReason})` : ""}, which is lost.`
          : "Its files, workspace and snapshots are removed. Conversations in T3 are not affected.",
        "This action cannot be undone.",
      ].join("\n"),
      { variant: "destructive" },
    );
    if (!confirmed) return;
    setPending(item.id);
    try {
      const result = await purge({ environmentId, input: { ids: [item.id] } });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: `Could not purge ${item.name}`,
          description: failureMessage(result, "Trellis did not respond."),
        });
        return;
      }
      toastManager.add({ type: "success", title: `Purged ${item.name}` });
    } finally {
      setPending(null);
      trashQuery.refresh();
    }
  };

  const emptyAll = async () => {
    const api = readLocalApi();
    if (!api) return;
    const confirmed = await api.dialogs.confirm(
      [
        `Permanently delete ${items.length} item${items.length === 1 ? "" : "s"} in the Trellis trash?`,
        "Their files, workspaces and snapshots are removed for good. Conversations in T3 are not affected.",
        "This action cannot be undone.",
      ].join("\n"),
      { variant: "destructive" },
    );
    if (!confirmed) return;
    setPending("*");
    try {
      const result = await emptyTrash({ environmentId, input: {} });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: "Could not empty the trash",
          description: failureMessage(result, "Trellis did not respond."),
        });
      }
    } finally {
      setPending(null);
      trashQuery.refresh();
    }
  };

  return (
    <SettingsSection
      {...idProp(props.id)}
      title={props.title}
      icon={<TrashIcon className="size-3.5" />}
      headerAction={
        items.length > 0 ? (
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={pending !== null}
            onClick={() => void emptyAll()}
          >
            Empty trash
          </Button>
        ) : null
      }
    >
      {items.length === 0 ? (
        <SettingsRow
          title={
            <span className="inline-flex items-center gap-2">
              {trashQuery.isPending ? <Spinner size="sm" tone="muted" /> : null}
              {trashQuery.isPending
                ? "Loading the trash"
                : trashQuery.error
                  ? "Could not load the trash"
                  : "The trash is empty"}
            </span>
          }
          description={
            trashQuery.error ??
            "Deleting a Trellis project or idea in T3 moves it here, where you can restore it."
          }
        />
      ) : (
        items.map((item) => (
          <SettingsRow
            key={`${item.kind}:${item.id}`}
            title={
              <span className="inline-flex min-w-0 items-center gap-2">
                {item.kind === "idea" ? (
                  <LightbulbIcon className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <SproutIcon className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate">{item.name}</span>
              </span>
            }
            description={
              <>
                {`${KIND_LABELS[item.kind]} · deleted ${formatDay(item.deletedAt)} · ${trashExpiryText(item)}`}
                {trashItemNotes(item) === null ? null : (
                  <span className="block">{trashItemNotes(item)}</span>
                )}
              </>
            }
            control={
              <div className="flex items-center gap-2">
                {item.purgeRequested != null ? (
                  <Button
                    size="sm"
                    variant="destructive-outline"
                    disabled={pending !== null}
                    onClick={() => void purgeItem(item)}
                  >
                    Purge
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending !== null}
                  onClick={() => void restoreItem(item)}
                >
                  {pending === item.id ? "Working…" : "Restore"}
                </Button>
              </div>
            }
          />
        ))
      )}
    </SettingsSection>
  );
}

/**
 * Trellis's snapshot timer, retention and expiry settings, one number per
 * row. A value is sent when its field commits (blur, Enter, the step
 * buttons), only that key, one write at a time; Trellis's refusal shows
 * under the row and the field goes back to the value in force.
 */
function TrellisHistorySection(props: {
  readonly environmentId: EnvironmentId;
  readonly id: string | undefined;
}) {
  const { environmentId } = props;
  const historyQuery = useEnvironmentQuery(
    trellisEnvironment.historySettings({ environmentId, input: {} }),
  );
  const update = useAtomCommand(trellisEnvironment.updateHistorySettings, {
    reportFailure: false,
  });
  const runMaintenance = useAtomCommand(trellisEnvironment.runMaintenance, {
    reportFailure: false,
  });
  const [maintaining, setMaintaining] = useState(false);
  // Saves still on their way; maintenance runs only after them, so it applies
  // the settings just entered (clicking Run now commits a focused field).
  // Resolves to whether every save since the last Run now succeeded.
  const writes = useRef<Promise<boolean>>(Promise.resolve(true));
  const maintainingRef = useRef(false);
  const thinNow = async () => {
    maintainingRef.current = true;
    setMaintaining(true);
    try {
      const saved = await writes.current;
      writes.current = Promise.resolve(true);
      // A setting the user just entered was refused or lost: running now
      // would apply the previous one.
      if (!saved) {
        toastManager.add({
          type: "error",
          title: "Maintenance did not run",
          description: "A history setting was not saved. Fix it, then run maintenance again.",
        });
        return;
      }
      const result = await runMaintenance({ environmentId, input: {} });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          toastManager.add({
            type: "error",
            title: "Could not run maintenance",
            description: failureMessage(result, "Trellis did not respond."),
          });
        }
        return;
      }
      toastManager.add({ type: "success", title: "Maintenance done" });
    } finally {
      maintainingRef.current = false;
      setMaintaining(false);
      historyQuery.refresh();
    }
  };
  const settings = historyQuery.data;
  // Kept in a ref as well, so commits made before a re-render see each other.
  const editsRef = useRef(NO_HISTORY_EDITS);
  const [edits, setEdits] = useState(NO_HISTORY_EDITS);
  const nextRevision = useRef(0);
  const apply = (change: (current: HistoryEdits) => HistoryEdits) => {
    editsRef.current = change(editsRef.current);
    setEdits(editsRef.current);
  };
  const inForce =
    settings === null
      ? {}
      : historyValuesInForce(settings.values, historyQuery.dataUpdatedAt, edits);
  const staleNotice = staleDetailsNotice({
    hasData: settings !== null,
    error: historyQuery.error,
    updatedAt: historyQuery.dataUpdatedAt,
  });

  const commit = async (key: HistoryKey, input: number | null) => {
    // Fields and resets wait while Run now runs (see `thinNow`).
    if (settings === null || maintainingRef.current) return;
    const current = historyFieldValue(
      key,
      historyValuesInForce(settings.values, historyQuery.dataUpdatedAt, editsRef.current),
      editsRef.current,
    );
    const edit = historyEdit(key, input, current);
    if (edit.kind === "unchanged") return;
    if (edit.kind === "invalid") {
      apply((current) => rejectHistoryEdit(current, key, edit.message));
      return;
    }
    const revision = ++nextRevision.current;
    apply((current) => startHistoryWrite(current, key, edit.value, revision));
    // Serial per environment, so writes reach Trellis in the order they were made;
    // maintenance waits for them (see `thinNow`).
    const write = update({ environmentId, input: edit.patch });
    writes.current = writes.current.then((earlier) =>
      write.then(
        (result) => earlier && result._tag !== "Failure",
        () => false,
      ),
    );
    const result = await write;
    if (result._tag === "Failure") {
      const message = isAtomCommandInterrupted(result)
        ? null
        : failureMessage(result, "Trellis did not respond.");
      apply((current) => finishHistoryWrite(current, key, revision, { ok: false, message }));
      return;
    }
    apply((current) =>
      finishHistoryWrite(current, key, revision, {
        ok: true,
        values: result.value.values,
        at: Date.now(),
      }),
    );
    const notice = wouldRemoveText(result.value.wouldRemove);
    if (notice !== null) {
      toastManager.add({ type: "info", title: "History settings saved", description: notice });
    }
    // For the snapshot counts; the values are already the write's answer.
    historyQuery.refresh();
  };

  const counts = settings === null ? null : snapshotCountsText(settings.snapshots);

  return (
    <SettingsSection
      {...idProp(props.id)}
      title="History"
      icon={<HistoryIcon className="size-3.5" />}
    >
      {settings === null ? (
        <SettingsRow
          title={
            <span className="inline-flex items-center gap-2">
              {historyQuery.isPending ? <Spinner size="sm" tone="muted" /> : null}
              {historyQuery.isPending
                ? "Loading history settings"
                : "Could not read the history settings"}
            </span>
          }
          description={historyQuery.error ?? undefined}
        />
      ) : (
        <>
          {staleNotice === null ? null : (
            <SettingsRow
              title={<WarningTitle>History settings may be out of date</WarningTitle>}
              description={staleNotice}
            />
          )}
          {HISTORY_SETTINGS.map((setting) => {
            const value = historyFieldValue(setting.key, inForce, edits);
            if (value === undefined) return null;
            const defaultValue = settings.defaults[setting.key];
            const defaultNote = historyDefaultNote(value, defaultValue, setting.unit);
            const message = edits.error?.key === setting.key ? edits.error.message : undefined;
            return (
              <SettingsRow
                key={setting.key}
                title={setting.title}
                description={setting.description}
                status={
                  message === undefined && defaultNote === null ? undefined : (
                    <>
                      {defaultNote === null ? null : <span className="block">{defaultNote}</span>}
                      {message === undefined ? null : (
                        <span role="alert" className="block text-destructive">
                          {message}
                        </span>
                      )}
                    </>
                  )
                }
                resetAction={
                  defaultNote === null || defaultValue === undefined ? undefined : (
                    <SettingResetButton
                      label={setting.title}
                      onClick={() => void commit(setting.key, defaultValue)}
                    />
                  )
                }
                control={
                  <div className="flex shrink-0 items-center gap-2">
                    <NumberField
                      // Controlled, so a commit (each arrow step) keeps the input
                      // mounted and focused; a refusal remounts it to drop the draft.
                      key={edits.resets[setting.key] ?? 0}
                      value={value ?? null}
                      min={0}
                      step={1}
                      size="sm"
                      className="w-32"
                      // No new saves while Run now waits for the earlier ones and runs.
                      disabled={maintaining}
                      onValueCommitted={(next) => void commit(setting.key, next)}
                    >
                      <NumberFieldGroup>
                        <NumberFieldDecrement aria-label={`Decrease ${setting.title}`} />
                        <NumberFieldInput
                          aria-label={`${setting.title} in ${setting.unit}s`}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") event.currentTarget.blur();
                          }}
                        />
                        <NumberFieldIncrement aria-label={`Increase ${setting.title}`} />
                      </NumberFieldGroup>
                    </NumberField>
                    <span className="w-14 text-xs text-muted-foreground">{`${setting.unit}s`}</span>
                  </div>
                }
              />
            );
          })}
          <SettingsRow
            title="Snapshots"
            description={counts?.byKind ?? "Live snapshots across all workspaces, by kind."}
            control={<Value>{counts?.total ?? 0}</Value>}
          />
          <SettingsRow
            title="Last thinning"
            description="Thinning runs with maintenance, about once an hour; Run now applies changed settings at once. It never purges projects."
            control={
              <span className="inline-flex items-center gap-2">
                <Value>{lastThinningText(settings.lastThinning, formatTime)}</Value>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={maintaining}
                  onClick={() => void thinNow()}
                >
                  {maintaining ? <Spinner size="sm" tone="muted" /> : null}
                  {maintaining ? "Running…" : "Run now"}
                </Button>
              </span>
            }
          />
        </>
      )}
    </SettingsSection>
  );
}
