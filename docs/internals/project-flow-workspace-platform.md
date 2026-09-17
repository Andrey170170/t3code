# Project flow and workspace-platform integration

Status: proposed custom-fork direction, preserved at the user's request on
2026-09-17. This describes intended behavior, not a shipped feature or an accepted
wire protocol. Product ownership is agreed; schemas, UI layout, and rollout are
still open.

## Product intent

T3 should let a user begin a conversation without first selecting a project,
directory, or machine. That conversation can remain discussion, discover existing
work, create a project, or coordinate ordinary threads across several projects.

The inspiration is the coordinator/new-or-existing-thread experience in
[Claude Projects redesigned](https://claude.com/blog/projects-redesigned).
The intended extension is to make it work across providers and user-controlled
machines, with explicit workspace continuity underneath.

The companion platform is currently called **Lattice Next**, a provisional name.
Its independent repository is `~/projects/lattice-next`. It is a fresh non-Python
implementation seeded from Lattice's design ideas; Rust is a candidate, not a
selected stack. It exposes a machine-facing interface and has no standalone
GUI/TUI product planned. One control plane and node executors are the initial
topology.

## Ownership: project experience in T3, workspace state in the backend

T3 owns the human-facing project flow: discovery presentation, creation/adoption
dialogs or conversational equivalents, goals, coordinator conversations,
thread navigation, context selection, progress, and user decisions. A project
overview may bring together decisions, references, artifacts, and relevant
threads. Shared memory/library behavior is a design area, not an implemented
requirement to ingest every transcript automatically.

The workspace platform owns durable project/workspace identity, workspace state
and lineage, machine enrollment and placement, isolation, environment reuse,
materialization, leases, capture/fork/restore, and domain-aware integration.
T3 presents those operations and their outcomes through its backend adapter.

T3 continues to own provider protocols, conversation history, native session
references, approvals, and user-facing thread controls. The backend does not need
to reimplement every provider's conversation protocol.

The existing T3 term `project` means an environment-local directory-rooted record.
The proposed backend project is a logical identity independent of machine/path
and may group several workspaces or sources. Preserve that distinction until an
explicit mapping/migration is chosen; matching names, paths, or Git remotes are
insufficient identity rules.

## Coordinator and ordinary threads are equal entry points

A coordinator organizes work through linked ordinary threads. Worker is a role,
not an exclusive thread type. Users can create and use threads directly, bring
an existing thread into an activity later, open a coordinator-created thread,
and return to the coordinator without losing decisions or progress.

An activity is user intent spanning zero or more projects/workspaces/threads;
the term is design vocabulary, not a final UI label. A coordinator can remain
project-free while work happens elsewhere. A private technical runtime or storage
container must not force repository selection or silently grant broad host access.

Direct user instructions and coordinator requests require explicit ordering.
Busy-thread dispatch, conflicting instructions, interruption, and concurrent
workspace writes must have visible outcomes. User steering must not be silently
overwritten by an older coordinator plan. Linking a thread does not automatically
authorize every coordinator action on it.

Keep ordinary controls available: model/provider selection, permissions, Stop,
questions/approvals, drafts, attachments, history, and direct follow-ups. Link,
unlink, revisit, pause coordination, and inspect provenance need clear semantics;
unlinking must not implicitly delete a thread or its workspace.

## Representative interaction

1. Start a new conversation without choosing a project.
2. Describe a goal or reference existing work; inspect relevant projects and
   threads with their machine/provider context.
3. Create/adopt a project, link an existing thread, or prepare an isolated
   workspace from a chosen source/checkpoint through the backend.
4. Open or resume an ordinary provider thread in that execution target.
5. Work directly in the thread, then return to the coordinator with the relevant
   progress, artifacts, and decisions preserved.
6. Close and reopen the client while the server-side work remains observable;
   reconnect without repeating accepted operations.

Conversation context and execution state are separate selections. A previous
thread can inform new work without being a restorable environment. Native session
resume is used where supported; otherwise continuation is an explicit handoff
with selected messages, artifacts, decisions, and workspace references. Switching
provider is not native session migration.

## Replace the workspace implementation, not just the worktree button

The user is willing to replace T3's worktree feature with the new backend.
Use a logical workspace handle and declared execution capabilities throughout.
The handle must support the runtime/transport needed by a provider, rather than
merely supply another host directory.

Provider execution, terminals, file and attachment access, previews/services,
diffs, checkpoint capture/restore, VCS status, merge/PR behavior, and cleanup must
refer to the same workspace state. T3 and the backend must not both believe they
own materialization or independently restore the same files.

Git remains a useful code-history substrate. Whole-workspace recovery and
integration must surface which environment/config/resource domains participate.
Existing T3 thread checkpoints need an explicit compatibility/migration policy;
replacing a worktree manager must not silently invalidate old restore points.

## Machines and background coordination

Multi-machine workspace management belongs to the backend. T3 displays node
capabilities, placement, readiness, recovery coverage, and operation status from
that authority. A T3 environment and a backend node are distinct identities;
their mapping may change as provider execution is integrated.

The coordinator's durable activity and dispatch live server-side so browser or
mobile disconnection does not end orchestration. The backend routes workspace
execution; T3 still needs a concrete path to the provider owner for thread
operations. Decide that bridge explicitly rather than building a second generic
machine registry in T3 or assuming current browser connections provide it.

Distinguish creating/opening work on either node from transferring state between
nodes. Disconnected is not stopped, and a lost response is not failed. Display
operation receipts and reconcile status before retrying work or reassigning a
writable workspace. Backend leases govern execution ownership.

## Current constraints that shape integration

Source baseline: `dev_vm` at `b7587c1e5c30820f5cdddd04ca5b8aaabed372b5`.
Recheck these observations before implementation.

- [Thread contracts](../../packages/contracts/src/orchestration.ts) require a
  project; project-free conversation persistence needs a deliberate schema/model
  decision. A synthetic project might serve a prototype but is not the product
  model by default.
- [Connection registry](../../packages/client-runtime/src/connection/registry.ts)
  federates environments in clients. It does not give a server-hosted coordinator
  automatic access to every server a browser can reach.
- [TaskService](../../apps/server/src/mcp/TaskService.ts) already supports durable
  agent-authored task operations, but scopes them to a project and Codex. Preserve
  its authority checks while designing broader coordinator capabilities; removing
  those checks alone is not the new interface.
- [Workspace resolution](../../apps/server/src/checkpointing/Utils.ts) and
  [provider startup](../../apps/server/src/provider/Layers/ProviderService.ts)
  assume host-visible paths. Isolation and remote execution require a broader
  execution adapter used consistently by surrounding features.

## Decisions still needed

- Durable activity and project-free conversation representation in T3.
- Mapping logical backend projects/workspaces to existing T3 records.
- Provider launch/connection inside isolated materializations and thread routing
  across execution owners, including native-resume constraints.
- Ordering and authority for direct-user/coordinator messages and workspace use.
- Shared context/decision/artifact ownership, selection, and update rules.
- Authentication, capability negotiation, request receipts, event subscriptions,
  and compatibility between T3 and backend releases.
- Transition for existing worktrees, thread checkpoints, cleanup, and projects
  that do not yet use the backend.

The first useful proof should cover an ordinary thread using one managed
workspace, then the coordinator/direct-thread round trip across two nodes. The
backend's recovery guarantees must be independently demonstrated. Include web,
desktop, mobile, local/remote connections, and explicit provider capability
coverage when defining implementation acceptance; keep raw event streams bounded.

## Design sources and maintenance

Backend domain/state design lives in `~/projects/lattice-next`; its README links
the architecture, glossary, accepted direction, roadmap, and original Lattice
design provenance. Those local paths are references, not build dependencies.
This note is the durable T3-side product/integration rationale requested by the
user. Update it as choices change instead of appending competing accounts.
