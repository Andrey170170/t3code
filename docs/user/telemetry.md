# Product usage data

This build collects no product usage events unless a server opts in. When enabled, the T3 Code
server sends them to this fork's collector at `t3-telemetry.andrei-homelab.com`, associated with a
hashed account or installation identifier. To count how many installations one person uses, the
server also sends hashed account identifiers: your T3 Connect account, your OpenAI and Claude
accounts when you are signed in, and a random identifier for each device that connects. Events
include the provider, model, reasoning effort,
permission mode, turn result, duration, release channel, and main-agent token totals when
available.

Events do not include prompts, responses, file contents, authentication tokens, conversation IDs,
raw provider events, or child-agent output. Child-agent token use is excluded from the totals.

To enable collection, set `T3CODE_TELEMETRY_ENABLED=true` and the collector's key in
`T3CODE_POSTHOG_KEY` in the server's environment before starting it. Without both, product events
are neither recorded nor sent. `T3CODE_POSTHOG_HOST` sends them to another PostHog-compatible
endpoint instead.

Builds that include T3 Connect tracing credentials also send relay connection traces to Axiom to
diagnose T3 Connect connectivity.

To turn relay tracing off, set `T3CODE_TELEMETRY_ENABLED=false` in the server's environment
before starting it. Relay tracing also stops when `T3CODE_OTEL_SDK_DISABLED` or
`OTEL_SDK_DISABLED` turns OpenTelemetry export off. The web app in a browser, including one the
`t3` CLI opens, does not read these variables.

The desktop app reads these variables from your shell profile (for example `~/.zshrc`) on macOS and
Linux, so export them there and restart the app. On Windows, set them as user environment variables.

## Export diagnostics to your own receiver

To send traces, metrics, or logs to an OpenTelemetry receiver, open
**Settings > General > Diagnostics**, select an environment, and enter each signal's OTLP HTTP
endpoint under **OpenTelemetry export** (for example `http://localhost:4318/v1/traces`). Save, then
restart that environment's server. The receiver must be reachable from the server's machine.
**Test** sends an empty export from the server to check an endpoint before or after you save it;
saved endpoints are checked when the section opens. Checks send authentication headers only to
the signal's currently running endpoint and do not follow redirects. To check a new endpoint
that requires authentication, save it and restart the server first.

`T3CODE_OTLP_*_URL` and standard `OTEL_EXPORTER_OTLP_*` environment variables override the saved
settings. For endpoints saved here or set with `T3CODE_OTLP_*_URL`, set `T3CODE_OTLP_HEADERS` for
receivers that need authentication and `T3CODE_OTLP_PROTOCOL=http/protobuf` for receivers that do
not accept JSON. An endpoint set with `OTEL_EXPORTER_OTLP_*` takes its headers and protocol from
`OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_EXPORTER_OTLP_PROTOCOL` instead.
