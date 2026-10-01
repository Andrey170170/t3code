function backtickRunLength(markdown: string, offset: number): number {
  let end = offset;
  while (markdown[end] === "`") end += 1;
  return end - offset;
}

function isEscaped(markdown: string, offset: number): boolean {
  let slashCount = 0;
  for (let index = offset - 1; index >= 0 && markdown[index] === "\\"; index -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

/**
 * Normalizes the LaTeX delimiters agents commonly emit to remark-math's
 * same-length dollar syntax. Fences, inline code, and HTML tags remain literal,
 * and unmatched delimiters are preserved while a response is streaming.
 */
export function normalizeMarkdownMathDelimiters(markdown: string): string {
  // Every offset below uses JavaScript's UTF-16 indexing. Keep the mutable
  // buffer on the same indexing model so astral characters before math do not
  // shift delimiter writes.
  const output = markdown.split("");
  let fence: { marker: "`" | "~"; length: number; quoteDepth: number } | null = null;
  let inlineCodeLength = 0;
  let htmlQuote: '"' | "'" | null = null;
  let insideHtmlTag = false;
  let pending: { offset: number; close: ")" | "]" } | null = null;
  let lineStart = 0;
  let fenceMarkerLineEnd = 0;

  for (let index = 0; index < markdown.length; index += 1) {
    const character = markdown[index];

    if (index === lineStart && inlineCodeLength === 0 && !insideHtmlTag) {
      const lineEnd = markdown.indexOf("\n", lineStart);
      const line = markdown.slice(lineStart, lineEnd === -1 ? markdown.length : lineEnd + 1);
      if (!fence && /^(?: {4}|\t)/.test(line)) {
        fenceMarkerLineEnd = lineStart + line.length;
      }
      // Container prefixes are source text too. Accept blockquote markers,
      // list markers, and their continuation indentation before a fence so
      // code nested in Markdown containers remains byte-for-byte literal.
      const fenceMatch =
        /^(?<containers>(?:(?:[ \t]{0,3}>[ \t]?)|(?:[ \t]{0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+))*)[ \t]{0,3}(?<marker>`{3,}|~{3,})(?<rest>[^\n]*)/.exec(
          line,
        );
      if (fenceMarkerLineEnd <= lineStart && fenceMatch?.groups?.marker) {
        const markerRun = fenceMatch.groups.marker;
        const marker = markerRun[0] as "`" | "~";
        const length = markerRun.length;
        const quoteDepth = fenceMatch.groups.containers?.match(/>/g)?.length ?? 0;
        if (!fence) {
          fence = { marker, length, quoteDepth };
        } else if (
          marker === fence.marker &&
          length >= fence.length &&
          quoteDepth === fence.quoteDepth &&
          /^[ \t]*$/.test(fenceMatch.groups.rest ?? "")
        ) {
          fence = null;
        }
        fenceMarkerLineEnd = lineStart + line.length;
      }
    }

    if (character === "\n") {
      lineStart = index + 1;
      continue;
    }
    if (index < fenceMarkerLineEnd || fence) continue;

    if (inlineCodeLength > 0) {
      if (character === "`" && backtickRunLength(markdown, index) === inlineCodeLength) {
        index += inlineCodeLength - 1;
        inlineCodeLength = 0;
      }
      continue;
    }
    if (character === "`") {
      inlineCodeLength = backtickRunLength(markdown, index);
      index += inlineCodeLength - 1;
      continue;
    }

    if (insideHtmlTag) {
      if (htmlQuote) {
        if (character === htmlQuote && !isEscaped(markdown, index)) htmlQuote = null;
      } else if (character === '"' || character === "'") {
        htmlQuote = character;
      } else if (character === ">") {
        insideHtmlTag = false;
      }
      continue;
    }
    if (character === "<" && /[A-Za-z!/?]/.test(markdown[index + 1] ?? "")) {
      insideHtmlTag = true;
      continue;
    }

    if (character !== "\\" || isEscaped(markdown, index)) continue;
    const delimiter = markdown[index + 1];
    if (!pending && (delimiter === "(" || delimiter === "[")) {
      pending = { offset: index, close: delimiter === "(" ? ")" : "]" };
      index += 1;
      continue;
    }
    if (pending && delimiter === pending.close) {
      output[pending.offset] = "$";
      output[pending.offset + 1] = "$";
      output[index] = "$";
      output[index + 1] = "$";
      pending = null;
      index += 1;
    }
  }

  return output.join("");
}
