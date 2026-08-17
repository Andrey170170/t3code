import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { describe, expect, it } from "vite-plus/test";

import {
  CHAT_MARKDOWN_REHYPE_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS,
  normalizeMarkdownMathDelimiters,
} from "./markdown-rendering";

function renderMarkdown(markdown: string, lineBreaks = false): string {
  return renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={
        lineBreaks ? CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS : CHAT_MARKDOWN_REMARK_PLUGINS
      }
      rehypePlugins={CHAT_MARKDOWN_REHYPE_PLUGINS}
    >
      {normalizeMarkdownMathDelimiters(markdown)}
    </ReactMarkdown>,
  );
}

describe("chat Markdown math", () => {
  it("renders display dollar math with KaTeX", () => {
    const display = renderMarkdown("$$\n\\frac{a}{b}\n$$");

    expect(display).toContain('class="katex-display"');
    expect(display).toContain('encoding="application/x-tex">\\frac{a}{b}</annotation>');
  });

  it("does not treat currency amounts as math delimiters", () => {
    const html = renderMarkdown("I'll treat up to $10 as the cap; the estimate is about $0.10.");

    expect(html).not.toContain('class="katex"');
    expect(html).toContain("$10 as the cap");
    expect(html).toContain("about $0.10");
  });

  it("renders paired LaTeX-style delimiters used by coding agents", () => {
    const inline = renderMarkdown("Energy is \\(E = mc^2\\).");
    const display = renderMarkdown("\\[\n\\sum_{i=1}^n i\n\\]");

    expect(inline).toContain('encoding="application/x-tex">E = mc^2</annotation>');
    expect(display).toContain('class="katex-display"');
    expect(display).toContain('encoding="application/x-tex">\\sum_{i=1}^n i</annotation>');
  });

  it("preserves astral text before paired delimiters", () => {
    const markdown = "Result 🚀: \\(x + 1\\).";
    const normalized = normalizeMarkdownMathDelimiters(markdown);
    const html = renderMarkdown(markdown);

    expect(normalized).toBe("Result 🚀: $$x + 1$$.");
    expect(html).toContain("Result 🚀:");
    expect(html).toContain('encoding="application/x-tex">x + 1</annotation>');
  });

  it("keeps math delimiters literal inside inline and fenced code", () => {
    const html = renderMarkdown("`\\(inline\\)`\n\n```sh\necho '\\[fenced\\]'\necho $HOME\n```");

    expect(html).not.toContain('class="katex"');
    expect(html).toContain("\\(inline\\)</code>");
    expect(html).toContain("\\[fenced\\]");
    expect(html).toContain("echo $HOME");
  });

  it("keeps paired delimiters literal in nested fenced code", () => {
    const blockquote = renderMarkdown("> ```txt\n> \\(blockquote code\\)\n> ```");
    const list = renderMarkdown("- ```txt\n  \\[list code\\]\n  ```");
    const quotedFence =
      "> ```txt\n``` does not close the quote\n> \\(still code\\)\n> ```\n\\(real math\\)";

    expect(blockquote).not.toContain('class="katex"');
    expect(blockquote).toContain("\\(blockquote code\\)");
    expect(list).not.toContain('class="katex"');
    expect(list).toContain("\\[list code\\]");
    expect(normalizeMarkdownMathDelimiters(quotedFence)).toContain(
      "> \\(still code\\)\n> ```\n$$real math$$",
    );
  });

  it("does not mistake indented code for a fenced block", () => {
    const markdown = "    ```\n\\(real math\\)";

    expect(normalizeMarkdownMathDelimiters(markdown)).toBe("    ```\n$$real math$$");
  });

  it("preserves unmatched delimiters while a message is streaming", () => {
    const markdown = "Still typing \\(x + 1";

    expect(normalizeMarkdownMathDelimiters(markdown)).toBe(markdown);
    expect(renderMarkdown(markdown)).not.toContain('class="katex"');
  });

  it("does not mistake a comparison operator for an HTML tag", () => {
    const html = renderMarkdown("When a < b, \\(a + 1 < b + 1\\).");

    expect(html).toContain("When a &lt; b");
    expect(html).toContain('class="katex"');
  });

  it("sanitizes raw HTML before generating trusted KaTeX output", () => {
    const html = renderMarkdown('<img src="x" onerror="alert(1)"> \\(x^2\\)');

    expect(html).not.toContain("onerror");
    expect(html).toContain('class="katex"');
    expect(html).toContain("<math");
    expect(html).toContain("style=");
  });

  it("renders math through the hard-break pipeline", () => {
    const html = renderMarkdown("First line\nthen \\(x\\)", true);

    expect(html).toContain("<br/>");
    expect(html).toContain('class="katex"');
  });

  it("renders fenced math without treating ordinary code fences as math", () => {
    const math = renderMarkdown("```math\n\\sqrt{x}\n```");
    const code = renderMarkdown("```ts\nconst price = '$5';\n```");

    expect(math).toContain('class="katex-display"');
    expect(code).not.toContain('class="katex"');
    expect(code).toContain("const price = &#x27;$5&#x27;;");
  });
});
