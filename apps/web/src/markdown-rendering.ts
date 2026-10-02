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

/** cmark's limit on nested parentheses in a link destination. */
const MAX_DESTINATION_PARENS = 32;
/** Longer titles are not recognized (their link's math is then normalized). */
const MAX_TITLE_LENGTH = 4096;

/** Skips spaces and tabs, and at most one line ending (no blank line). */
function skipLinkWhitespace(markdown: string, offset: number): number {
  let index = offset;
  let newline = false;
  while (index < markdown.length) {
    const character = markdown[index];
    if (character === " " || character === "\t") index += 1;
    else if (character === "\n" && !newline) {
      newline = true;
      index += 1;
    } else break;
  }
  return index;
}

/**
 * The offset after a link destination starting at `offset`, or -1:
 * `<…>` (no line ending, `<` or unescaped `>` inside), or a run without
 * spaces or controls whose parentheses balance (to cmark's depth limit).
 */
function linkDestinationAfter(markdown: string, offset: number): number {
  if (markdown[offset] === "<") {
    for (let index = offset + 1; index < markdown.length; index += 1) {
      const character = markdown[index];
      if (character === "\\") index += 1;
      else if (character === ">") return index + 1;
      else if (character === "<" || character === "\n") return -1;
    }
    return -1;
  }
  let depth = 0;
  let index = offset;
  for (; index < markdown.length; index += 1) {
    const character = markdown[index]!;
    if (character === "\\" && /[!-/:-@[-`{-~]/.test(markdown[index + 1] ?? "")) index += 1;
    else if (character === "(") {
      if (++depth > MAX_DESTINATION_PARENS) return -1;
    } else if (character === ")") {
      if (depth === 0) break;
      depth -= 1;
    } else if (character.charCodeAt(0) <= 0x20 || character === "\u007f") break;
  }
  return depth === 0 ? index : -1;
}

/** The offset after a link title (`"…"`, `'…'` or `(…)`) at `offset`, or -1. */
function linkTitleAfter(markdown: string, offset: number): number {
  const open = markdown[offset];
  const close = open === "(" ? ")" : open === '"' || open === "'" ? open : null;
  if (close === null) return -1;
  // Bounded, so text full of unclosed titles stays linear while streaming.
  const limit = Math.min(markdown.length, offset + MAX_TITLE_LENGTH);
  for (let index = offset + 1; index < limit; index += 1) {
    const character = markdown[index];
    if (character === "\\") index += 1;
    else if (character === close) return index + 1;
    else if (open === "(" && character === "(") return -1;
    // A blank line ends the paragraph, and with it the link.
    else if (character === "\n" && /^[ \t]*\n/.test(markdown.slice(index + 1, index + 80))) {
      return -1;
    }
  }
  return -1;
}

/**
 * The offset of the `)` closing an inline link's destination and title,
 * `(` at `offset`, read as CommonMark does; -1 when it is no link.
 */
function inlineLinkEnd(markdown: string, offset: number): number {
  let index = skipLinkWhitespace(markdown, offset + 1);
  if (markdown[index] === ")") return index;
  index = linkDestinationAfter(markdown, index);
  if (index === -1) return -1;
  const afterDestination = index;
  index = skipLinkWhitespace(markdown, index);
  if (markdown[index] === ")") return index;
  // A title needs whitespace before it.
  if (index === afterDestination) return -1;
  index = linkTitleAfter(markdown, index);
  if (index === -1) return -1;
  index = skipLinkWhitespace(markdown, index);
  return markdown[index] === ")" ? index : -1;
}

/** `<scheme:…>` or `<address@host>` at `offset`, as CommonMark autolinks. */
const AUTOLINK =
  /<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*|[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/y;

/** A link reference definition's label and destination, at a line start. */
const REFERENCE_DEFINITION =
  /[ ]{0,3}\[(?:[^\\[\]]|\\.){1,999}\]:[ \t]*\n?[ \t]*(?:<(?:[^<>\n\\]|\\.)*>|[^\s<][^\s]*)/y;

/**
 * Normalizes the LaTeX delimiters agents commonly emit to remark-math's
 * same-length dollar syntax. Fences, inline code, HTML tags, autolinks and
 * link destinations and titles (inline and in reference definitions) remain
 * literal, and unmatched delimiters are preserved while a response is
 * streaming.
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
  // Unescaped `[` that may still open a link; a link closes all of them, as
  // links cannot contain links.
  let linkOpeners = 0;

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

    if (index === lineStart && inlineCodeLength === 0 && !insideHtmlTag && pending === null) {
      REFERENCE_DEFINITION.lastIndex = index;
      if (REFERENCE_DEFINITION.test(markdown)) {
        index = REFERENCE_DEFINITION.lastIndex - 1;
        continue;
      }
    }

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
    // An autolink (<https://…>, <me@host>) ends at its `>`, quotes and all.
    if (character === "<") {
      AUTOLINK.lastIndex = index;
      if (AUTOLINK.test(markdown)) {
        index = AUTOLINK.lastIndex - 1;
        continue;
      }
    }
    if (character === "[" && !isEscaped(markdown, index)) {
      linkOpeners += 1;
      continue;
    }
    // A link destination, `[text](…)`, is a URL: `\(` there is an escaped paren.
    if (character === "]" && !isEscaped(markdown, index) && linkOpeners > 0) {
      linkOpeners -= 1;
      if (markdown[index + 1] === "(") {
        const end = inlineLinkEnd(markdown, index + 1);
        if (end !== -1) {
          linkOpeners = 0;
          index = end;
        }
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
