import { CodexThreadImportButton } from "../CodexThreadImport";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** Keep imports available before any project exists, while respecting the selected scope. */
export function CodexImportSettings() {
  const { scope, environments } = useSettingsScope();
  const projectScope = scope.kind === "project" || scope.kind === "checkout";
  const targets = projectScope
    ? scope.members.map((member) => {
        const environment = environments.find(
          (entry) => entry.environmentId === member.environmentId,
        );
        return {
          key: `${member.environmentId}:${member.id}`,
          environmentId:
            environment?.connection.phase === "connected" ? member.environmentId : null,
          projectId: member.id,
          workspaceRoot: member.workspaceRoot,
          label: `${environment?.label ?? "machine"}: ${member.workspaceRoot}`,
        };
      })
    : environments.map((environment) => ({
        key: environment.environmentId,
        environmentId:
          environment.connection.phase === "connected" ? environment.environmentId : null,
        label: environment.label,
      }));

  // Per-machine labels are long, so several of them go under the description
  // instead of squeezing it in the row's control column.
  const buttons =
    targets.length > 0 ? (
      targets.map(({ key, label, ...target }) => (
        <CodexThreadImportButton
          key={key}
          {...target}
          label={targets.length > 1 ? `Import from ${label}` : "Import conversations"}
        />
      ))
    ) : (
      <CodexThreadImportButton environmentId={null} />
    );

  return (
    <SettingsSection id="import-conversations" title="Conversations">
      <SettingsRow
        title="Import conversations"
        description={
          projectScope
            ? "Choose existing Codex conversations to import into this project."
            : "Choose existing Codex conversations from any project on a connected machine."
        }
        control={targets.length > 1 ? undefined : buttons}
      >
        {targets.length > 1 ? (
          <div className="mt-3 flex flex-wrap gap-2 pb-2">{buttons}</div>
        ) : null}
      </SettingsRow>
    </SettingsSection>
  );
}
