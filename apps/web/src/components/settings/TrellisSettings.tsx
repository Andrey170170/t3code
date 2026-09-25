import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, TrellisTrashItem } from "@t3tools/contracts";
import { LightbulbIcon, SproutIcon, TrashIcon } from "lucide-react";
import { useState } from "react";

import { useTrellisStatusFor } from "../../hooks/useTrellis";
import { readLocalApi } from "../../localApi";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { trellisEnvironment } from "../../state/trellis";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import { useSettingsScope } from "./SettingsScopeContext";

function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0], fallback: string) {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const formatDay = (unixSeconds: number) => dateFormat.format(new Date(unixSeconds * 1000));

/** When a trashed item goes away for good, in words. */
export function trashExpiryText(item: Pick<TrellisTrashItem, "expiresAt">): string {
  return item.expiresAt === null
    ? "Kept until you empty the trash"
    : `Removed for good on ${formatDay(item.expiresAt)}`;
}

const KIND_LABELS: Readonly<Record<TrellisTrashItem["kind"], string>> = {
  idea: "Idea",
  project: "Project",
  workspace: "Fork",
};

/**
 * Trellis settings of each selected environment: the integration switch, its
 * connection state, and the Trellis trash with restore.
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
  const integration = searchableSetting("trellis-integration");
  const trash = searchableSetting("trellis-trash");

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
      ? "Off. T3 does not contact Trellis on this environment."
      : state === "ready"
        ? `Connected${status?.root ? ` · workspaces in ${status.root}` : ""}.`
        : `On, but Trellis is not answering${socketPath ? ` at ${socketPath}` : ""}. Start it with \`trellis serve\`.`;

  return (
    <>
      <SettingsSection
        {...(props.anchors ? { id: integration.id } : {})}
        title={label === null ? "Trellis" : `Trellis · ${label}`}
        icon={<SproutIcon className="size-3.5" />}
      >
        <SettingsRow
          title="Use Trellis workspaces"
          description="Ideas and Trellis projects run in isolated workspaces with snapshots. While off, existing Trellis projects keep their conversations, but their agents do not run."
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
        <TrellisTrashSection
          environmentId={environmentId}
          title={label === null ? trash.title : `${trash.title} · ${label}`}
          {...(props.anchors ? { id: trash.id } : {})}
        />
      ) : null}
    </>
  );
}

function TrellisTrashSection(props: {
  readonly environmentId: EnvironmentId;
  readonly title: string;
  readonly id?: string;
}) {
  const { environmentId } = props;
  const trashQuery = useEnvironmentQuery(trellisEnvironment.trash({ environmentId, input: {} }));
  const restore = useAtomCommand(trellisEnvironment.restore, { reportFailure: false });
  const emptyTrash = useAtomCommand(trellisEnvironment.emptyTrash, { reportFailure: false });
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
      {...(props.id === undefined ? {} : { id: props.id })}
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
            "Deleting a Trellis project or idea moves it here. Ideas are removed after 30 days; projects stay until you empty the trash."
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
            description={`${KIND_LABELS[item.kind]} · deleted ${formatDay(item.deletedAt)} · ${trashExpiryText(item)}`}
            control={
              <Button
                size="sm"
                variant="outline"
                disabled={pending !== null}
                onClick={() => void restoreItem(item)}
              >
                {pending === item.id ? "Restoring…" : "Restore"}
              </Button>
            }
          />
        ))
      )}
    </SettingsSection>
  );
}
