import type { CodexThreadsHistoryResult, EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useEffect, useRef, useState } from "react";
import { Image, Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { codexThreads } from "../../state/codex-threads";
import { useAtomCommand } from "../../state/use-atom-command";

function NativeHistoryItem({ item }: { item: Readonly<Record<string, unknown>> }) {
  const [expanded, setExpanded] = useState(false);
  const text =
    typeof item.text === "string"
      ? item.text
      : Array.isArray(item.content)
        ? item.content
            .flatMap((content: unknown) =>
              typeof content === "object" &&
              content !== null &&
              "text" in content &&
              typeof content.text === "string"
                ? [content.text]
                : [],
            )
            .join("\n")
        : "";
  const output =
    typeof item.aggregatedOutput === "string"
      ? item.aggregatedOutput
      : typeof item.output === "string"
        ? item.output
        : "";
  const images = Array.isArray(item.content)
    ? item.content.flatMap((content: unknown) => {
        if (
          typeof content !== "object" ||
          content === null ||
          !("url" in content) ||
          typeof content.url !== "string"
        )
          return [];
        return /^(https?:\/\/|data:image\/)/.test(content.url) ? [content.url] : [];
      })
    : [];
  const kind = typeof item.type === "string" ? item.type : "History item";
  return (
    <View className="gap-2 border-b border-border-subtle py-3">
      <Text className="text-xs text-foreground-muted">
        {kind === "userMessage" ? "You" : kind === "agentMessage" ? "Codex" : kind}
      </Text>
      {text ? (
        <Text selectable className="text-foreground">
          {text}
        </Text>
      ) : null}
      {output ? (
        <Text selectable className="font-mono text-xs text-foreground-muted">
          {output}
        </Text>
      ) : null}
      {[...new Set(images)].map((uri) => (
        <Image
          key={uri}
          accessibilityLabel="Imported attachment"
          source={{ uri }}
          resizeMode="contain"
          style={{ width: "100%", height: 220 }}
        />
      ))}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
      >
        <Text className="text-xs text-accent">
          {expanded ? "Hide details" : "Show full item details"}
        </Text>
      </Pressable>
      {expanded ? (
        <Text selectable className="font-mono text-xs text-foreground-muted">
          {JSON.stringify(item, null, 2)}
        </Text>
      ) : null}
    </View>
  );
}

/** Native history stays separate from T3's live messages and loads only on demand. */
export function CodexImportedHistory(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  onLegacyHistoryVisibilityChange: (hidden: boolean) => void;
}) {
  const load = useAtomCommand(codexThreads.history, { reportFailure: false });
  const [page, setPage] = useState<CodexThreadsHistoryResult | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const { onLegacyHistoryVisibilityChange } = props;
  const hideLegacyHistory = open && page?.boundary?.replacesLegacyMessages === true;
  useEffect(() => {
    onLegacyHistoryVisibilityChange(hideLegacyHistory);
  }, [hideLegacyHistory, onLegacyHistoryVisibilityChange]);
  const read = async (cursor?: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const result = await load({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, ...(cursor ? { cursor } : {}) },
    });
    busyRef.current = false;
    setBusy(false);
    if (result._tag === "Failure") {
      setError(String(Cause.squash(result.cause)));
      return;
    }
    setPage((old) => ({
      ...result.value,
      items: cursor ? [...(old?.items ?? []), ...result.value.items] : result.value.items,
    }));
  };
  if (page?.imported === false) return null;
  return (
    <View className="gap-2 py-3">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => {
          setOpen(!open);
          if (!page && !open) void read();
        }}
      >
        <Text className="text-center text-sm text-accent">
          {open ? "Hide imported Codex history" : "View imported Codex history"}
        </Text>
      </Pressable>
      {open ? (
        <>
          {error ? (
            <>
              <Text accessibilityRole="alert" className="text-red-500">
                {error}
              </Text>
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                onPress={() => void read(page?.nextCursor ?? undefined)}
              >
                <Text className="text-accent">Retry</Text>
              </Pressable>
            </>
          ) : null}
          {busy ? (
            <Text className="text-center text-foreground-muted">Loading history…</Text>
          ) : null}
          {page?.nextCursor ? (
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() => void read(page.nextCursor ?? undefined)}
            >
              <Text className="text-center text-accent">Load older history</Text>
            </Pressable>
          ) : null}
          {page
            ? page.items
                .toReversed()
                .map((entry, index) => (
                  <NativeHistoryItem
                    key={`${entry.turnId}:${String(entry.item.id ?? index)}`}
                    item={entry.item}
                  />
                ))
            : null}
          {page?.imported ? (
            <Text className="text-center text-xs text-foreground-muted">
              Imported Codex history ends here. Messages below were recorded in T3.
            </Text>
          ) : null}
        </>
      ) : null}
    </View>
  );
}
