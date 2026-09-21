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

The companion platform is called **Trellis**, the working name.
Its independent repository is `~/projects/trellis`. It is a fresh non-Python
implementation seeded from Lattice's design ideas. Bend 2 owns its state-logic
engine; Rust owns system integration and external effects, with an explicit
internal protocol whose transport is still undecided. T3 consumes the platform
interface rather than depending on that internal language split. Trellis has no standalone
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
and lineage, workspace placement, isolation, environment reuse,
materialization, leases, capture/fork/restore, and domain-aware integration.
T3 presents those operations and their outcomes through its backend adapter.
Bootstrap owns fleet enrollment, machine identity, connectivity, and host
configuration; Trellis consumes that interface and owns work inside workspaces.

T3 continues to own provider protocols, conversation history, native session
references, approvals, and user-facing thread controls. The backend does not need
to reimplement every provider's conversation protocol.

The existing T3 term `project` means an environment-local directory-rooted record.
The proposed backend project is a logical identity independent of machine/path
and may group several workspaces or sources. Preserve that distinction until an
explicit mapping/migration is chosen; matching names, paths, or Git remotes are
insufficient identity rules.

## Cockpit and ordinary threads

Cockpit is the working name for the special project-free agent entry point.
Project agents and machine agents remain uniform ordinary agents; there is no
coordinator/worker taxonomy among them. Users can create and use threads directly,
link an existing thread into an activity, open a Cockpit-created thread, and
return to Cockpit without losing decisions or progress.

An activity is user intent spanning zero or more projects/workspaces/threads;
the term is design vocabulary, not a final UI label. Cockpit can remain
project-free while work happens elsewhere. Initially its harness uses a normal
host environment and a dedicated persistent working directory, with instructions
and skills to keep new projects out of that directory. The directory is not a
filesystem isolation boundary.

Direct user instructions and coordinator requests require explicit ordering.
Busy-thread dispatch, conflicting instructions, interruption, and concurrent
workspace writes must have visible outcomes. User steering must not be silently
overwritten by an older coordinator plan. Linking a thread does not automatically
authorize every coordinator action on it.

Keep ordinary controls available: model/provider selection, permissions, Stop,
questions/approvals, drafts, attachments, history, and direct follow-ups. Link,
unlink, revisit, pause coordination, and inspect provenance need clear semantics;
unlinking must not implicitly delete a thread or its workspace.

## Initial rollout and execution mode

Managed Trellis projects start fresh during the initial pilot. Ordinary host mode
remains available for established projects and machine administration; it does
not imply Trellis adoption or workspace recovery guarantees. In Trellis mode,
the project harness and native tools execute inside the materialization.

Project creation can record the project and its first empty workspace before
starting a container. The pilot has one default OCI base image; per-project base
overrides are deferred. Expose only required system support/knowledge initially,
without application templates. File-history initialization is system setup;
Jujutsu is the intended versioning direction, retaining Git interoperability;
concrete integration still needs validation. The UI must not
confuse a recorded project with a ready execution environment.

A Host/Trellis control near the current checkpoint control is a UX candidate.
The actual machine and host directory or managed workspace must be clear.
Initially this selects where work starts; moving an existing conversation across
hosts or divergent workspace states is not required. Do not silently relocate an
active operation or convert an existing host project. Same-workspace runtime
restart/recovery and the exact thread binding remain to be specified.

Default context is the project plus explicitly shared material, with broader
permitted discovery in Cockpit. Knowledge has lineage alongside other state,
with general cross-project/machine, project, and workspace scopes plus files/notes
visible in materializations. Durable notes are file-backed workspace state;
temporary scratch is separate. Shared project knowledge evolves independently of
a workspace branch. Sessions/experiments record selected shared revisions, expose
newer revisions for explicit refresh, and do not rewind shared stores when a
workspace is restored. History does not make a claim automatically current.

Initially agents can publish into enabled shared scopes without per-entry human
approval; observe actual publication and usefulness before tightening policy.
Expose standard scope directories, Markdown notes, and machine-maintained
revision/provenance metadata; ordinary project docs remain valid sources. Shared
knowledge needs revision history and reconciliation of concurrent workspace
edits, with Jujutsu the intended versioning backend pending integration proof. The publishing agent pulls
current shared state, reconciles its candidate, and retries if another publisher
advances the head first. Unresolved candidates stay retained; conflicting findings
preserve their conditions/evidence. Pulling for publication does not silently
refresh an experiment's pinned knowledge inputs. Publication and pulling newer
shared context are explicit agent actions. Automatic captures preserve local
drafts without publishing them. Exact paths/schema, backend, and merge mechanics
remain open. This does not broaden
visibility into deliberately isolated projects.

For now, multi-project edits use a host-side conversation. Later scoped agent
communication may let a project agent request work in another materialization.
Project-level planning/dispatch can use this mechanism without introducing a
separate coordinator/worker taxonomy. Materializations remain separate execution
contexts; communication does not imply shared writable filesystems.

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

## Workspace identity and activity ancestry

A Trellis project groups workspace branches; a workspace owns durable state/history
and an evolving tip; a materialization realizes that workspace on a node. Initially
there are zero or one active materializations per workspace. Parallel alternatives
fork separate workspaces from checkpoints; raw captures are not direct fork bases.
"Fork current" first establishes a checkpoint, then creates the requested children
in one user action. Multiple alternatives share that checkpoint; an existing
checkpoint can also be selected directly. "Fork here" on a historical capture
may first promote it to a retained checkpoint if its required state still exists;
promotion preserves its actual recovery coverage.
Replacement of a stopped runtime is not a new branch.
A top-level agent and its delegated subagents may share the materialization.
One active top-level agent per workspace is a preference, not an enforced
single-writer rule. Independent alternatives use separate workspace forks, even
when delegated by one agent. Many T3 threads can use the same workspace over
time; creating a thread does not itself fork state. A resumed thread operates on
current workspace state. Do not add automatic catch-up context or conversation
repair; keep actual target/state indicators up to date and let the agent inspect
its environment. Automatic Trellis captures occur at top-level turn boundaries,
not every subagent turn. Explicit captures remain available during work;
checkpoints are deliberate milestones established after active work stops properly,
including when fork/integration/restore creates one as part of a larger action.
Do not treat checkpointing as a brief freeze followed by automatic work resumption.
The user or agent must first stop relevant work and managed workspace services
properly. Otherwise checkpoint creation fails with an error identifying what is
still running; it does not stop work or wait automatically. The caller decides
whether to stop or wait, then retries. Agent checkpointing is a dedicated tool
call, ideally the only active call at that moment. Idle harness/control processes
can stay alive; after the result, the agent can continue in the same turn without
a user "continue" prompt. Trellis does not itself restart stopped jobs/services.
Exact blocker detection remains open. Automatic captures may
expire under configurable retention limits; checkpoints and required dependent
state remain protected until deliberate removal. Retained activity records do not
promise that every historical state remains restorable.
Rolling environment tracking belongs to Trellis and proceeds independently of
agent turns and return-point creation. Agent interruption does not imply loss of
post-capture environment changes or cause automatic rollback.

T3 Stop preserves the provider harness's normal agent-stop semantics. It does not
stop the materialization, its services, or environment tracking; workspace shutdown
is a separate lifecycle operation. Delegated-run cancellation follows the actual
provider contract rather than an invented universal process-tree kill.
Materializations initially require an explicit workspace stop; ending a turn,
closing a thread, or disconnecting a client does not retire them. Idle suspension
and resource reclamation are future work, requiring awareness of ongoing jobs and
services. No process-preserving sleep mechanism is selected.

Captures/checkpoints are cross-domain return points. Activity also has ancestry:
a fork must not automatically receive unrelated sibling or later parent activity.
Preserving ancestor events through the fork checkpoint and recording integration
links without rewriting event origins is the proposed timeline model. A linear
UI presentation need not linearize the stored provenance graph. Native provider
conversation history remains distinct from both activity and state restoration.

Restore and Fork must be distinct actions. Restore preserves a checkpoint of
current state, then restores the full recorded state of the selected
capture/checkpoint into the same workspace. It creates a new history record rather
than erasing intervening work: files/code receive a new revision with the selected
contents, and other state domains record equivalent transitions where applicable.
The history retains the pre-restore state and the selected return point. Fork
creates a separate workspace from a checkpoint and leaves the original unchanged.
Neither rewinds independent project/general knowledge stores or provider
conversation history. Coverage follows the return point's participating domains.
Selective historical restoration is a separate, deferred operation, distinct from
the accepted selective integration workflow. Provisional startup behavior restores
declared service configuration and starts services marked for automatic startup;
arbitrary commands and experiments are not automatically rerun. If restore fails,
show that the workspace needs recovery and retain the pre-restore checkpoint and
operation details. Recovery is explicit user/agent work, with inspection and repair
access preserved; do not automatically roll back or silently repair the workspace.
If the materialization cannot start, use an ordinary host-mode agent with the
failed operation details and Trellis inspection/repair tools. Recovery outside
the workspace uses a separate host conversation; the original project thread stays
attached to its workspace. Concrete runtime transition and repair interfaces remain open.

Archive and Delete must also be distinct. Archive is the normal retirement path
when no work will continue in a workspace: preserve a final checkpoint, release
its runtime, and retain its identity/history for reopening. A source or integration
workspace with continuing work remains active after integration. Do not infer
completion from inactivity. Explicit workspace deletion is supported, protecting
state and provenance still required by surviving workspaces or retained return
points. Otherwise private state/checkpoints/history are released for garbage
collection unless explicitly retained elsewhere.

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

## Service registration and preview identity

Persistent services require explicit user/agent registration of launch settings
and startup behavior. An observed background command or listening port is not
automatically a managed service. Process/port visibility can remain separate;
VS Code-style discovery heuristics and suggestions are future work. Forks inherit
registered service declarations/startup settings. Service startup on fork
materialization start defaults to enabled and can be disabled per project. A failed
service must leave an otherwise usable workspace available to its agent, with
failure details/logs for repair; service readiness is separate from workspace health.

Trellis provides logical service addresses tied to workspace/service identity,
stable across restarts/restores and distinct for each fork. T3 should use those
addresses rather than temporary node/port locations. Trellis owns the current
endpoint mapping; Bootstrap owns enrolled machines' network membership/connectivity.
T3 owns browser preview access across that infrastructure: connecting the browser
to one T3 environment should suffice to access workspace services on other enrolled
machines without separately pairing each worker. This is private preview access;
public publishing is outside this feature. Concrete routing/relay transport and
access checks remain open.

## Integration workspace experience

An integration workspace is an ordinary workspace where an agent can inspect
inputs and actually reconcile a merge using its normal tools. Support selection
of individual changes across domains, including code hunks and a desired package
from a larger experimental installation set. The agent must be able to resolve
required supporting changes/dependencies and validate the candidate before
explicit application to the target. This is not just a read-only merge preview
and does not inherently require human approval for each integration.

Establish source and target checkpoints at integration start and a result
checkpoint after the merge. Distinguish the original fork/common ancestor from
the target's state at integration start; the selected inputs remain fixed for
that attempt. Prefer leaving the target unchanged during integration, but do not
lock either workspace. The source may continue freely. If current target state
still matches its input checkpoint, apply the resolved result; otherwise retain
the result and integrate it with the newer target in another attempt. Check
rolling state as well as named checkpoints; this is not a long-lived write lock.

Keep intended contributions, candidate changes, and validation results inspectable.
Shared project/general knowledge continues through its explicit publication flow.
Applying a result may restart/recreate the target materialization when needed.
Durable workspace state and conversation history survive; preserving live processes
is not an initial requirement. Code-only changes may apply without restart where
supported. This is part of explicit integration apply, not the agent Stop action.
Exact apply/failure recovery, provider reconnection, and code-history presentation
remain to be designed; preserve activity/contribution provenance.

## Machines and background coordination

Multi-machine workspace management belongs to the backend. T3 displays node
capabilities, placement, readiness, recovery coverage, and operation status from
that authority. A T3 environment and a backend node are distinct identities;
their mapping may change as provider execution is integrated. Creating a project
should not require choosing a machine/directory first: Trellis selects suitable
placement from explicit requirements, project preferences, and state locality.
The catalog is the normal way to find and continue work. Existing materializations
stay put; no automatic migration/rebalancing is required initially. When no suitable
node is available, keep the project record, show useful capability/availability
information, and allow a manual placement override for compatible preparatory work.
For example, sketch a GPU project on a CPU node while its GPU node is down, retaining
the unmet requirement. Do not silently queue the start request or claim the override
supplies missing capabilities. Later saved-state transfer can support continuation
on the capable node; its concrete workflow and milestone remain open.

The coordinator's durable activity and dispatch live server-side so browser or
mobile disconnection does not end orchestration. The backend routes workspace
execution; T3 still needs a concrete path to the provider owner for thread
operations. Decide that bridge explicitly rather than building a second generic
machine registry in T3 or assuming current browser connections provide it.

Initial multi-machine use covers creating/opening work on either node. Explicit
transfer of saved state is a later capability; transparent movement of a running
materialization or its conversation is not required. Disconnected is not stopped, and a lost response is not failed. Display
operation receipts and reconcile status before retrying work or reassigning a
writable workspace. Existing agents, builds, and services may continue local work
during control-plane disconnection; centrally coordinated operations are unavailable
until reconnection. Do not replace an unreachable materialization on another node.
Backend ownership reconciliation must support this behavior. Checkpoint creation
requires the control plane and returns an unavailable error during disconnection.
Local tracking continues; independently finalized offline checkpoints are deferred
to later decentralization.

Initially one retained copy of checkpoint state on its owning node is sufficient.
Display storage location and availability without implying machine-loss protection.
Replication/durability hardening and control-plane decentralization are a later
second wave, not prerequisites for the initial product.

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
workspace, then the Cockpit/direct-thread round trip on one node before expanding to two. The
backend's recovery guarantees must be independently demonstrated. Include web,
desktop, mobile, local/remote connections, and explicit provider capability
coverage when defining implementation acceptance; keep raw event streams bounded.

## Design sources and maintenance

Backend domain/state design lives in `~/projects/trellis`; its README links
the architecture, glossary, accepted direction, roadmap, and original Lattice
design provenance. Those local paths are references, not build dependencies.
This note is the durable T3-side product/integration rationale requested by the
user. Update it as choices change instead of appending competing accounts.
