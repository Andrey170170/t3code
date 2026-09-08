import ChatMarkdown from "./ChatMarkdown";
import type { EnvironmentId, ThreadId, CodexThreadsHistoryResult } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { codexThreads } from "../state/codexThreads";
import { useAtomCommand } from "../state/use-atom-command";
import { Button } from "./ui/button";

/** A separate snapshot excludes every turn started after adoption into T3. */
export function CodexNativeHistory({
  environmentId,
  threadId,
  onLegacyVisibilityChange,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  onLegacyVisibilityChange: (replacing: boolean) => void;
}) {
  const history = useAtomCommand(codexThreads.history, { reportFailure: false });
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<CodexThreadsHistoryResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const replacesLegacyMessages = result?.boundary?.replacesLegacyMessages === true;
  useEffect(() => {
    onLegacyVisibilityChange(open && replacesLegacyMessages);
    return () => onLegacyVisibilityChange(false);
  }, [open, replacesLegacyMessages, onLegacyVisibilityChange]);
  async function load(cursor?: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    const response = await history({
      environmentId,
      input: { threadId, ...(cursor ? { cursor } : {}) },
    });
    inFlight.current = false;
    setBusy(false);
    if (response._tag !== "Success") {
      setError("Could not load original history. Try again.");
      return;
    }
    setResult((previous) => ({
      ...response.value,
      items:
        cursor && previous ? [...previous.items, ...response.value.items] : response.value.items,
    }));
  }
  return (
    <div className="shrink-0 border-b px-4 py-2 text-sm">
      <button
        type="button"
        className="text-muted-foreground hover:text-foreground"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          if (!open && !result?.imported) void load();
        }}
      >
        {open ? "Hide" : "Show"} original Codex history
      </button>
      {open ? (
        <div className="max-h-80 overflow-auto py-2">
          {result?.imported ? (
            <>
              <p className="pb-2 text-xs text-muted-foreground">
                Original history before import
                {result.boundary
                  ? ` on ${new Date(result.boundary.importedAt).toLocaleString()}`
                  : ""}
                . New T3 turns appear below.
              </p>
              {result.nextCursor ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void load(result.nextCursor ?? undefined)}
                >
                  Load older history
                </Button>
              ) : (
                <p className="text-xs text-muted-foreground">Beginning of available history</p>
              )}
              {result.items.toReversed().map(({ turnId, item }, index) => (
                <NativeItem
                  key={`${turnId}:${String(item.id ?? index)}`}
                  item={item}
                  environmentId={environmentId}
                />
              ))}
              <p className="border-t pt-2 text-xs text-muted-foreground">
                End of original history · Continued in T3 below
              </p>
            </>
          ) : result ? (
            <p>No imported native history is attached to this conversation.</p>
          ) : null}
          {busy ? <p role="status">Loading history…</p> : null}
          {error ? (
            <p role="alert">
              {error}{" "}
              <button onClick={() => void load(result?.nextCursor ?? undefined)}>Retry</button>
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function NativeItem({
  item,
  environmentId,
}: {
  item: Record<string, unknown>;
  environmentId: EnvironmentId;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const type = typeof item.type === "string" ? item.type : "Unknown item";
  const text =
    typeof item.text === "string"
      ? item.text
      : typeof item.output === "string"
        ? item.output
        : typeof item.aggregatedOutput === "string"
          ? item.aggregatedOutput
          : null;
  return (
    <article className="my-3 rounded border p-3">
      <p className="mb-1 text-xs font-medium text-muted-foreground">
        {type === "userMessage" ? "You" : type === "agentMessage" ? "Assistant" : type}
      </p>
      {text ? (
        type === "agentMessage" ? (
          <ChatMarkdown
            text={text}
            cwd={undefined}
            environmentId={environmentId}
            parseRawHtml={false}
          />
        ) : (
          <pre className="whitespace-pre-wrap break-words font-sans text-sm">{text}</pre>
        )
      ) : null}
      {Array.isArray(item.content)
        ? item.content.map((part: unknown, index: number) => {
            if (typeof part !== "object" || part === null) return null;
            const content = part as Record<string, unknown>;
            if (typeof content.text === "string")
              return (
                <p
                  key={`${String(content.type)}:${index}`} // eslint-disable-line react/no-array-index-key -- Native snapshot content never reorders.
                  className="whitespace-pre-wrap break-words"
                >
                  {content.text}
                </p>
              );
            const url =
              typeof content.url === "string"
                ? content.url
                : typeof content.image_url === "string"
                  ? content.image_url
                  : null;
            if (url && /^(https?:\/\/|data:image\/(png|jpeg|webp|gif);base64,)/i.test(url))
              return (
                <img
                  key={`${String(content.type)}:${index}`} // eslint-disable-line react/no-array-index-key -- Native snapshot content never reorders.
                  src={url}
                  alt="Original conversation attachment"
                  loading="lazy"
                  className="max-h-64 max-w-full rounded"
                />
              );
            return (
              <p
                key={`${String(content.type)}:${index}`} // eslint-disable-line react/no-array-index-key -- Native snapshot content never reorders.
                className="text-xs text-muted-foreground"
              >
                {String(content.type ?? "Attachment")}: available in original item details.
              </p>
            );
          })
        : null}
      <details
        className="mt-2 text-xs text-muted-foreground"
        onToggle={(event) => setDetailsOpen(event.currentTarget.open)}
      >
        <summary>Original item details</summary>
        {detailsOpen ? (
          <pre className="overflow-x-auto whitespace-pre-wrap break-words">
            {JSON.stringify(item, null, 2)}
          </pre>
        ) : null}
      </details>
    </article>
  );
}
