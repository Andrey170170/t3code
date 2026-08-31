import type { Options as ReactMarkdownOptions } from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

import { remarkGithubAlerts } from "./markdown-github-alerts";
import { remarkNormalizeListItemIndentation } from "./markdown-list-indentation";

type RemarkPlugins = NonNullable<ReactMarkdownOptions["remarkPlugins"]>;
type RehypePlugins = NonNullable<ReactMarkdownOptions["rehypePlugins"]>;
type SanitizeSchema = NonNullable<Parameters<typeof rehypeSanitize>[0]>;

type MarkdownAstNode = {
  type?: string;
  meta?: unknown;
  data?: {
    hProperties?: Record<string, unknown>;
  };
  children?: MarkdownAstNode[];
};

function remarkPreserveCodeMeta() {
  return (tree: MarkdownAstNode) => {
    const visit = (node: MarkdownAstNode) => {
      if (node.type === "code" && typeof node.meta === "string" && node.meta.trim().length > 0) {
        node.data = {
          ...node.data,
          hProperties: {
            ...node.data?.hProperties,
            dataCodeMeta: node.meta.trim(),
          },
        };
      }
      node.children?.forEach(visit);
    };

    visit(tree);
  };
}

/**
 * Fenced code also lands on the `code` component, and inline vs block is no
 * longer distinguishable there once both render `<code>` — so inline spans are
 * tagged on the mdast, where the distinction still exists. Code inside a link
 * label stays untagged: linkifying it would nest an anchor inside the link's
 * anchor and steal its clicks.
 */
function remarkTagInlineCode() {
  return (tree: MarkdownAstNode) => {
    const visit = (node: MarkdownAstNode, insideLink: boolean) => {
      if (node.type === "inlineCode" && !insideLink) {
        node.data = {
          ...node.data,
          hProperties: {
            ...node.data?.hProperties,
            dataInlineCode: "",
          },
        };
      }
      const childInsideLink = insideLink || node.type === "link" || node.type === "linkReference";
      node.children?.forEach((child) => visit(child, childInsideLink));
    };

    visit(tree, false);
  };
}

export const CHAT_MARKDOWN_SANITIZE_SCHEMA: SanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    "*": (defaultSchema.attributes?.["*"] ?? []).filter((attribute) => attribute !== "title"),
    code: [...(defaultSchema.attributes?.code ?? []), "dataCodeMeta", "dataInlineCode"],
    blockquote: [...(defaultSchema.attributes?.blockquote ?? []), "dataAlert"],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "file"],
  },
};

export const CHAT_MARKDOWN_REMARK_PLUGINS: RemarkPlugins = [
  remarkGfm,
  [remarkMath, { singleDollarTextMath: false }],
  remarkGithubAlerts,
  remarkNormalizeListItemIndentation,
  remarkPreserveCodeMeta,
  remarkTagInlineCode,
];

export const CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS: RemarkPlugins = [
  remarkGfm,
  [remarkMath, { singleDollarTextMath: false }],
  remarkGithubAlerts,
  remarkNormalizeListItemIndentation,
  remarkBreaks,
  remarkPreserveCodeMeta,
  remarkTagInlineCode,
];

// Sanitize untrusted raw Markdown HTML before KaTeX expands the small, allowed
// `language-math` marker into its trusted MathML and styled presentation tree.
export const CHAT_MARKDOWN_REHYPE_PLUGINS: RehypePlugins = [
  rehypeRaw,
  [rehypeSanitize, CHAT_MARKDOWN_SANITIZE_SCHEMA],
  rehypeKatex,
];

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
