# Markdown and math

T3 Code renders Markdown in chat messages, plans, file previews, and pull request descriptions.
The web client also renders LaTeX math with KaTeX.

Use `\(...\)` for inline math and double-dollar delimiters for display math:

```markdown
The invariant is \(E = mc^2\).

$$
\sum_{i=1}^{n} i = \frac{n(n+1)}{2}
$$
```

Single dollar signs stay literal so ordinary prices such as `$10` and `$0.10` cannot accidentally
turn the prose between them into math. The web client also accepts multiline `\[...\]` for display
math. A fenced `math` block renders as display math:

````markdown
```math
\int_0^1 x^2\,dx = \frac{1}{3}
```
````

Math-looking text inside inline code or an ordinary code fence remains literal. KaTeX supports a
large, safe subset of LaTeX, but not arbitrary LaTeX packages or document commands.
