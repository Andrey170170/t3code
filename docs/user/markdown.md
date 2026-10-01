# Markdown and math

T3 Code renders Markdown in chat messages, plans, file previews, and pull request descriptions.
The web and desktop clients also render LaTeX math with KaTeX.

Use `\(...\)` for inline math and multiline `$$...$$` for display math:

```markdown
The invariant is \(E = mc^2\).

$$
\sum_{i=1}^{n} i = \frac{n(n+1)}{2}
$$
```

Inline `$$...$$` and multiline `\[...\]` are also supported. Single dollar signs stay literal so prices and shell variables do not become math.
A fenced `math` block renders as display math:

````markdown
```math
\int_0^1 x^2\,dx = \frac{1}{3}
```
````

Math-looking text inside inline code or an ordinary code fence remains literal. KaTeX supports a
large, safe subset of LaTeX, but not arbitrary LaTeX packages or document commands.
