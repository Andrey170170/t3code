# Markdown and math

T3 Code renders Markdown in chat messages, plans, file previews, and pull request descriptions.
The web client also renders LaTeX math with KaTeX.

Use dollar delimiters for inline and display math:

```markdown
The invariant is $E = mc^2$.

$$
\sum_{i=1}^{n} i = \frac{n(n+1)}{2}
$$
```

The web client also accepts `\(...\)` for inline math and multiline `\[...\]` for display math.
A fenced `math` block renders as display math:

````markdown
```math
\int_0^1 x^2\,dx = \frac{1}{3}
```
````

Math-looking text inside inline code or an ordinary code fence remains literal. KaTeX supports a
large, safe subset of LaTeX, but not arbitrary LaTeX packages or document commands.
