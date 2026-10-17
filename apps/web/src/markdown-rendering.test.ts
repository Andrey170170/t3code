import { describe, expect, it } from "vite-plus/test";

import { normalizeMarkdownMathDelimiters } from "./markdown-rendering";

describe("normalizeMarkdownMathDelimiters", () => {
  it("rewrites paired delimiters without shifting astral text before them", () => {
    expect(normalizeMarkdownMathDelimiters("Result 🚀: \\(x + 1\\).")).toBe(
      "Result 🚀: $$x + 1$$.",
    );
  });

  it("keeps a quoted fence literal until its own quote closes it", () => {
    const quotedFence =
      "> ```txt\n``` does not close the quote\n> \\(still code\\)\n> ```\n\\(real math\\)";

    expect(normalizeMarkdownMathDelimiters(quotedFence)).toContain(
      "> \\(still code\\)\n> ```\n$$real math$$",
    );
  });

  it("keeps escaped parentheses in link destinations and autolinks literal", () => {
    expect(
      normalizeMarkdownMathDelimiters("See [the docs](https://example.com/a_\\(b\\)) and \\(x\\)."),
    ).toBe("See [the docs](https://example.com/a_\\(b\\)) and $$x$$.");
    expect(normalizeMarkdownMathDelimiters("<https://example.com/it's\\(v1\\)> then \\(y\\)")).toBe(
      "<https://example.com/it's\\(v1\\)> then $$y$$",
    );
    expect(normalizeMarkdownMathDelimiters("\\[z\\](note)")).toBe("$$z$$(note)");
  });

  it("does not mistake indented code for a fenced block", () => {
    expect(normalizeMarkdownMathDelimiters("    ```\n\\(real math\\)")).toBe(
      "    ```\n$$real math$$",
    );
  });

  it("preserves unmatched delimiters while a message is streaming", () => {
    const markdown = "Still typing \\(x + 1";

    expect(normalizeMarkdownMathDelimiters(markdown)).toBe(markdown);
  });
});
