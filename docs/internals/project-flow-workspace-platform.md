# Project flow and Trellis integration

Consolidated 2026-09-22. Accepted product direction; no Trellis integration is
implemented or validated by this note. Backend semantics live in
[the Trellis state model](../../../trellis/docs/state-model.md); implementation
sequencing lives in [its roadmap](../../../trellis/docs/roadmap.md). This document
owns T3-specific experience, provider seams, and integration constraints.

## Experience and ownership

Start without selecting a project in **Cockpit**, or use an ordinary thread directly.
Create/find managed work through the catalog without choosing its machine/path first.
Cockpit remains an ongoing conversation and can link ordinary threads that users
open and steer directly. Other agents are uniform; coordinator/worker is not a
permanent type distinction. An activity may span zero or more projects/threads.

| Component                      | Authority                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| T3/provider adapters           | Conversations/transcripts, provider sessions, dispatch, direct/coordinated UX, management and previews        |
| Trellis                        | Logical projects/workspaces, placement, state/history/recovery, execution, storage/services                   |
| Bootstrap                      | Fleet enrollment/connectivity and host/user/harness configuration; workspace application goes through Trellis |
| Future connection/auth manager | External-account lifecycle and scoped connections; product remains unselected                                 |
| Existing CHPC project          | Cluster staging, scheduler/jobs and results through an adapter                                                |

See [ecosystem overview](../../../trellis/docs/ecosystem.md). Trellis is a fresh
headless Bend 2/Rust implementation inspired by Lattice; no standalone GUI/TUI.
Its API is unified for T3, a CLI frontend, and structured tools. Require explicit
credentials and target/operation authorization: LAN membership and resource IDs do
not grant machine control. Token lifecycle/transport must be specified before remote use.

T3's current directory-rooted environment-local project record is not the desired
Trellis project entity. Paths or matching Git remotes are not identity mappings.
A T3 environment is not inherently a Trellis node. Do not build a second fleet or
state authority in T3, or independently restore the files Trellis owns.

## First release and execution modes

Prioritize a fresh isolated project on one node and one provider before scratch,
multiple nodes, or adoption. Host mode remains available for existing projects and
machine work; selecting it does not imply adoption or recovery coverage.
In managed isolated mode the harness and native tools run inside the materialization.

A project can exist before execution: metadata, empty initialized history, one
workspace, one default OCI base, only required system scaffolding. A catalog record
is not necessarily a ready environment. Expose the actual machine/mode/target;
a toggle near checkpoint controls was a UX candidate, not a fixed design.

Cockpit initially runs in a normal host environment with a dedicated persistent cwd.
Instructions direct project creation through Trellis; the cwd is not isolation.
Cross-project edits initially use host conversations. Broader scoped inter-agent
communication follows later, without permanent agent classes.

Many threads can reuse one workspace. Resumed old threads operate on its current
state without automatic catch-up summaries or conversation repair. Main agents
and cooperating subagents may share a materialization; independent alternatives
use separate workspace forks. Initially each isolated workspace has at most one
active materialization, including across nodes.

## Direct control and dispatch

Persist Cockpit activity, thread references, routing, and dispatch server-side;
browser closure must not stop orchestration. Link/unlink does not create/delete
workspace state. Keep ordinary model/provider controls, permissions, Stop, drafts,
attachments, direct follow-ups, and native history available.

Queue Cockpit requests to busy threads visibly by default. Stopping or redirecting
work requires an explicit interrupt action, and stale queued plans cannot silently
override direct user steering. Exact sequencing/receipts need an implementation,
not a renewed product decision about whether takeover is allowed.

T3 Stop requests the provider's normal agent stop, including its actual delegated
cancellation behavior. It does not stop the runtime, services, or environment tracker.
Both isolated and scratch runtimes stop explicitly initially; turn completion,
client disconnect, and idle time do not retire them.

## One execution-target interface

Replace the worktree implementation through a logical workspace handle used by:
provider launch/protocol connection, terminal/native tools, files/attachments,
diffs/history, previews/services, VCS/PR, capture/restore, integration, and cleanup.
An adapter that only substitutes a host cwd cannot support isolated/remote execution.
Mark unsupported paths rather than letting them act on the server's unrelated files.

Trellis handles workspace operations; T3 retains native provider protocol/session
ownership. A node-side launch/connection bridge is an integration candidate. Preserve
existing adapters where possible, but qualify actual auth, cwd, transport, Stop, and
resume behavior for each supported provider. Exact node-runner transport remains open.

Host/materialization agents need a short operational orientation: actual context,
Trellis purpose, API/tools, storage/service requests, expectations and reference links.
Bootstrap installs host/harness guidance; Trellis supplies workspace facts/semantics;
T3 injects session context where appropriate. This is not shared project memory.

## History and recovery UX

Branches and deliberate checkpoints are the default view; automatic captures and
finer state/activity details are optional. Clean Git status does not mean unchanged
Trellis state: Git-ignored files and actual environment mutations may be retained.
Do not present a successful code snapshot as a successful full workspace capture.

| Action/status   | T3 must communicate                                                                                                                                        |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Checkpoint      | Caller stops work/services; blockers produce an error. Dedicated tool returns to the still-running agent; no user "continue" required.                     |
| Capture         | Automatic at top-level boundaries. Required-domain failure is incomplete, not a Restore/fork source.                                                       |
| Fork            | Separate workspace from checkpoint; current-state checkpoint or promotion of a complete retained historical capture may be part of one action.             |
| Restore         | Full participating state in the same workspace, preserving pre-restore checkpoint and adding history; does not rewind native transcripts/shared knowledge. |
| Recovery needed | Retain outcomes/logs and allow explicit agent/user repair, not silent rollback. Host recovery thread can repair an unstartable materialization.            |
| Integration     | Ordinary integration workspace; fixed S0/T0, selective changes, result R; an advanced target needs another integration, not overwrite.                     |
| Archive/delete  | Separate operations; archive retains completed work, delete releases private history subject to surviving references.                                      |

These are UI obligations; [state model](../../../trellis/docs/state-model.md) owns
complete backend rules. Existing T3 checkpoints/worktrees need an explicit migration/
compatibility policy that preserves old restore points and unmanaged host behavior.

## Storage, knowledge, and services

Storage UI/API exposes independent access, pinning, and sharing settings. Supported
managed sources default pinned; live/unpinned use is explicit. Project-default
changes and application to selected workspaces are separate. Restore/fork of pinned
sources uses independent derived bindings; live resources stay untouched, with
observed version differences shown where available. Explicitly cross-project shared
sources can be discovered/reused, normally read-only; attachment grants no implicit writes.
Agents can provision/attach storage and receive a usable path without manual host setup.

Knowledge is file-backed general/project/workspace state with selected shared revisions.
Pull and publish are explicit. The later publishing agent reconciles conflicts against
the current head; retain unresolved candidates and avoid silent overwrite or refreshing
experiment inputs. T3 exposes selection/publication provenance rather than treating
memory as perpetually current. Shared stores are not rolled back with a workspace.

Register services explicitly; do not promote observed ports automatically. Fork
startup is configurable/default enabled. A failed dev server leaves its workspace
usable for repair. Trellis maps stable workspace/service addresses to current ports;
forks get distinct addresses. Bootstrap supplies private fleet connectivity. T3
makes previews accessible through an existing browser connection without pairing
each worker separately. This is not public publishing.

## Multi-machine continuation

Trellis supplies node capabilities, placement, operation status, coverage, and
content locations. No suitable node produces useful failure details while retaining
the project; manual preparatory override is allowed, not a claim of missing capability.
No automatic placement queue or rebalancing is required initially.

The first useful multi-node release includes relocation and remote forks. Sequential
CPU-to-GPU continuation defaults to relocating the same workspace; independent work
can fork. Transfer retained checkpoint state after properly stopping work; no live
process migration. Preserve the source until the destination is verified usable.
Incompatibility fails transfer; the user/host agent fixes and retries or abandons.

Retain the same visible conversation where supported, using native resume or explicit
supported handoff. Same-thread UX is not a universal provider portability guarantee.
The single-node pilot need not support arbitrary conversation moves between hosts or
divergent workspace states. Same-workspace relocation is the later explicit workflow.

Disconnected is not stopped, and a lost response is not proof of failure. Existing
local work/tracking continues through control-plane disconnection; central operations
including checkpoints fail unavailable. Never replace an unreachable runtime elsewhere
without ownership reconciliation. Display one-copy durability honestly; replication
and control-plane decentralization are a later hardening wave.

## Scratch after the isolated pilot

Scratch is ordinary project creation through the same API, available to Cockpit and
normal agents. Support one-off scripts, data processing, and visualizations in shared
execution with separate persistent directories and reduced environment guarantees.
Files/results/conversations do not expire automatically. Explicit runtime stop
must not delete them. Exact file-history controls and shared-runtime mechanics are open.

No graduation or environment/history/conversation migration is required. A larger
idea starts a new isolated project with selected copied notes/files.

## Historical source evidence and remaining engineering work

The original source audit used `dev_vm` at
`b7587c1e5c30820f5cdddd04ca5b8aaabed372b5`. These are historical findings to refresh
before implementation, not verified-current runtime claims:

| Finding                                                    | Source pointers in this repo                                                                                                                      |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Durable threads require project association                | [thread contracts](../../packages/contracts/src/orchestration.ts), [decider](../../apps/server/src/orchestration/decider.ts)                      |
| Environment federation belongs to clients                  | [connection registry](../../packages/client-runtime/src/connection/registry.ts)                                                                   |
| Existing task operations are same-project/Codex scoped     | [TaskService](../../apps/server/src/mcp/TaskService.ts)                                                                                           |
| Execution/checkpoint paths assume host-visible directories | [workspace utilities](../../apps/server/src/checkpointing/Utils.ts), [provider service](../../apps/server/src/provider/Layers/ProviderService.ts) |

Resolve project-free persistence and logical ID mapping; provider/node runner transport;
API auth/token provisioning; queue ordering/receipts; private preview transport;
backend capability/coverage compatibility; and legacy checkpoint/worktree migration.
Ownership, queue-by-default, explicit publication/pull, and isolated-first rollout
are settled. Do not reopen them as unanswered product choices.

Implement one ordinary isolated thread before Cockpit, then expand providers/nodes
according to Trellis's roadmap. Use isolated development state. Define and verify
claimed web/desktop/mobile and local/remote surfaces, with bounded event views.
Backend state recovery needs independent evidence; T3 UI success alone does not prove it.
