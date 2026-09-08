import { useNavigation } from "@react-navigation/native";
import type { CodexThreadsListResult, ProviderInstanceId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useRef, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, Switch, View } from "react-native";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { codexThreads } from "../../state/codex-threads";
import { useEnvironmentServerConfig, useProjects } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";

export function SettingsCodexImportRouteScreen() {
  const navigation = useNavigation();
  const projects = useProjects();
  const [projectKey, setProjectKey] = useState<string | null>(null);
  const project = projects.find((p) => `${p.environmentId}:${p.id}` === projectKey) ?? projects[0];
  const config = useEnvironmentServerConfig(project?.environmentId ?? null);
  const providers =
    config?.providers.filter((provider) => provider.driver === "codex" && provider.enabled) ?? [];
  const [selectedProvider, setSelectedProvider] = useState<ProviderInstanceId | null>(null);
  const provider = providers.find((p) => p.instanceId === selectedProvider) ?? providers[0];
  const [search, setSearch] = useState("");
  const [archived, setArchived] = useState(false);
  const [page, setPage] = useState<CodexThreadsListResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const list = useAtomCommand(codexThreads.list, { reportFailure: false });
  const importThread = useAtomCommand(codexThreads.import, { reportFailure: false });
  const reset = () => {
    generation.current++;
    setPage(null);
    setError(null);
    setBusy(false);
  };
  const browse = async (cursor?: string) => {
    if (!project || !provider || busy) return;
    const request = ++generation.current;
    setBusy(true);
    setError(null);
    const result = await list({
      environmentId: project.environmentId,
      input: {
        providerInstanceId: provider.instanceId,
        search,
        archived,
        ...(cursor ? { cursor } : {}),
      },
    });
    if (request !== generation.current) return;
    setBusy(false);
    if (result._tag === "Failure") {
      setError(String(Cause.squash(result.cause)));
      return;
    }
    setPage((old) => ({
      ...result.value,
      threads: cursor ? [...(old?.threads ?? []), ...result.value.threads] : result.value.threads,
    }));
  };
  const importSelected = async (
    nativeThreadId: string,
    archived: boolean,
    cwdOverride?: string,
  ) => {
    if (!project || !provider || busy) return;
    const request = ++generation.current;
    setBusy(true);
    setError(null);
    const result = await importThread({
      environmentId: project.environmentId,
      input: {
        providerInstanceId: provider.instanceId,
        projectId: project.id,
        nativeThreadId,
        archived,
        ...(cwdOverride ? { cwdOverride } : {}),
      },
    });
    if (request !== generation.current) return;
    setBusy(false);
    if (result._tag === "Failure") {
      setError(String(Cause.squash(result.cause)));
      return;
    }
    setPage((old) =>
      old
        ? {
            ...old,
            threads: old.threads.map((thread) =>
              thread.id === nativeThreadId
                ? {
                    ...thread,
                    existingThreadId: result.value.threadId,
                    historyUpgradeAvailable: false,
                    historyAvailable: true,
                  }
                : thread,
            ),
          }
        : old,
    );
  };
  return (
    <View className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Import Codex Chats" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-4 p-5 pb-12"
      >
        <Text className="text-foreground-muted">
          Choose where imported chats should appear. Browse Codex conversations on that environment,
          including other directories and worktrees. Imported chats appear in your sidebar.
        </Text>
        <SettingsSection title="Destination project">
          {projects.map((p) => (
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ checked: p === project }}
              key={`${p.environmentId}:${p.id}`}
              className="p-4"
              onPress={() => {
                reset();
                setProjectKey(`${p.environmentId}:${p.id}`);
                setSelectedProvider(null);
              }}
            >
              <Text className="text-foreground">
                {p === project ? "✓ " : ""}
                {p.title}
              </Text>
              <Text className="text-xs text-foreground-muted">{p.workspaceRoot}</Text>
            </Pressable>
          ))}
          {projects.length === 0 ? (
            <Text className="p-4 text-foreground-muted">Add a project before importing chats.</Text>
          ) : null}
        </SettingsSection>
        <SettingsSection title="Codex account">
          {providers.map((p) => (
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ checked: p === provider }}
              key={p.instanceId}
              className="p-4"
              onPress={() => {
                reset();
                setSelectedProvider(p.instanceId);
              }}
            >
              <Text className="text-foreground">
                {p === provider ? "✓ " : ""}
                {p.displayName ?? p.instanceId}
              </Text>
            </Pressable>
          ))}
          {providers.length === 0 ? (
            <Text className="p-4 text-foreground-muted">
              No enabled Codex account in this environment.
            </Text>
          ) : null}
        </SettingsSection>
        <TextInput
          accessibilityLabel="Search Codex chats"
          placeholder="Search chats"
          value={search}
          onChangeText={(value) => {
            reset();
            setSearch(value);
          }}
          className="rounded-lg border border-border-subtle p-3 text-foreground"
        />
        <View className="flex-row items-center justify-between">
          <Text className="text-foreground">Archived Codex chats</Text>
          <Switch
            accessibilityLabel="Archived Codex chats"
            value={archived}
            onValueChange={(value) => {
              reset();
              setArchived(value);
            }}
          />
        </View>
        <Pressable
          accessibilityRole="button"
          disabled={busy || !provider || !project}
          onPress={() => void browse()}
          className="rounded-lg bg-accent p-3"
        >
          <Text className="text-center text-white">{busy ? "Working…" : "Browse chats"}</Text>
        </Pressable>
        {error ? (
          <Text accessibilityRole="alert" className="text-red-500">
            {error}
          </Text>
        ) : null}
        {page?.threads.length === 0 ? (
          <Text className="text-foreground-muted">No matching chats.</Text>
        ) : null}
        {archived ? (
          <Text className="text-foreground-muted">
            Import restores archived conversations so you can continue them.
          </Text>
        ) : null}
        {page?.threads.map((thread) => (
          <View key={thread.id} className="gap-2 rounded-lg border border-border-subtle p-4">
            <Text className="text-foreground">{thread.title || "Untitled chat"}</Text>
            <Text className="text-xs text-foreground-muted">
              {thread.cwd} · {new Date(thread.updatedAt).toLocaleDateString()}
            </Text>
            {thread.existingThreadId && !thread.historyUpgradeAvailable ? (
              <Text className="text-foreground-muted">Already in T3</Text>
            ) : (
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                onPress={() => {
                  if (project && !thread.existingThreadId && thread.cwd !== project.workspaceRoot) {
                    Alert.alert(
                      "Choose the continuation folder",
                      `This chat used ${thread.cwd}. Importing into ${project.workspaceRoot} continues it in that folder. To keep the original folder, add it as a project and select it instead.`,
                      [
                        { text: "Cancel", style: "cancel" },
                        {
                          text: "Use selected project folder",
                          onPress: () =>
                            void importSelected(thread.id, thread.archived, project.workspaceRoot),
                        },
                      ],
                    );
                  } else {
                    void importSelected(thread.id, thread.archived);
                  }
                }}
                className="py-2"
              >
                <Text className="text-accent">
                  {thread.historyUpgradeAvailable ? "Load full history" : "Import chat"}
                </Text>
              </Pressable>
            )}
          </View>
        ))}
        {page?.nextCursor ? (
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={() => void browse(page.nextCursor ?? undefined)}
            className="p-3"
          >
            <Text className="text-center text-accent">Load older chats</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </View>
  );
}
