# Trellis workspaces

Trellis runs projects in isolated workspaces with snapshots, so an agent can change a whole
environment and you can roll it back. Quick ideas live as folders in a shared scratch workspace;
Trellis projects get workspaces of their own. T3 Code shows each idea, project and fork as a project
in the sidebar and runs Codex and Claude inside the workspace.

The integration is off by default and set per environment. Trellis itself must be installed and
running on that machine.

## Turning it on

Open **Settings** > **Trellis** and turn on **Use Trellis workspaces**. The row shows whether T3 Code
reaches Trellis. While the integration is off, T3 Code does not contact Trellis; existing Trellis
projects keep their conversations, but their agents do not run until you turn it back on.

T3 Code uses the socket at `/trellis/state/api.sock` unless the server was started with
`TRELLIS_SOCKET` set.

## Ideas and projects

**New idea** (sidebar, command palette or its shortcut) opens an empty draft. The idea is created in
Trellis when you send the first message, and the thread moves into it; a draft you abandon leaves
nothing behind.

**New Trellis project** in the command palette creates a project right away, optionally from a git
repository. **Find in Trellis** searches ideas and projects and opens the workspace that matched,
including forks.

New ideas and projects are named from their first thread: a name appears when its first turn
finishes and is refined once after the third turn. A name you or an agent gave, or a repository's
name, is never replaced.

## Agents, terminals and previews

Codex and Claude threads in a Trellis project run inside its workspace; other providers are refused
there. Git worktrees are not available in Trellis projects, since they would run outside the
workspace: use a Trellis fork for parallel work instead.

Workspaces see the Claude and Codex homes Trellis mounts into them (by default `~/.claude` and
`~/.codex`; Trellis's `config.json` can name others, and `trellis status` lists them). A Trellis
thread runs only with a provider instance whose home, from its settings or `CLAUDE_CONFIG_DIR` and
`CODEX_HOME`, is exactly the mounted path; otherwise the turn fails and names both homes (or says
that Trellis mounts no home for that provider). To run Trellis
threads from other homes, set the instance's home path to the one Trellis mounts. Codex instances
with a shadow home or a managed ChatGPT connection cannot run Trellis threads.

A terminal opened in a Trellis project is a shell inside the workspace, at the same path you see on
the host.

`localhost` in a Trellis thread means its workspace, not the machine T3 Code runs on. When you or an
agent open `localhost:8000` in the preview, T3 Code asks Trellis to publish that workspace port and
loads the published address instead, keeping the path. If Trellis cannot publish it (for example,
the workspace is stopped), the preview shows an error rather than loading the host's port.

## Moving a thread to another project

**Move to project** in a thread's menu or the command palette moves a thread to another Trellis
project. It keeps its conversation and continues in the new project's workspace; the files of its
earlier turns stay in the old project, so reverting one of those turns can rewind the conversation
but not restore its files. A thread that is working, or a fork that has not run yet, cannot move.

## Graduating an idea

**Graduate idea** in the command palette, or **Graduate** in an idea's project settings, turns an
idea into a project with its own Trellis workspace, from a base you pick, starting with a copy of the
idea's folder. Every active thread of the idea moves there with its conversation; the thread shows the
move, and a thread whose turn the graduation ended continues there on its own. Packages installed while it was an idea do not come along; `trellis changes --graduation`
in the project lists them. Graduating is refused while a thread of the idea is working; an agent can
graduate its own idea with the `trellis_graduate` tool, which ends its turn and continues it in the
new project. An idea graduated with `trellis graduate` on the command line has its threads moved
into the project within a few seconds, and a message sent to one in the meantime asks you to send it
again once it has moved.

## Forks and workers

A Trellis project's settings (**Settings** > **Project**) list its workspaces: the project's own,
forks you made, forks its agents' workers run in, and discarded forks. **Fork…** copies a workspace
as it was at one of its checkpoints into a new fork, listed in the sidebar, and opens a thread there.

An agent can delegate a task into a fork of its own workspace, made from a checkpoint it chooses; to
fork the current state it takes a checkpoint first. These worker forks stay out of the sidebar and
appear in the workspace list with the thread that spawned them. A worker's final message is recorded
as its fork's summary, which the lead reads when it merges the work. Archiving a thread stops and
archives its workers; their forks stay until someone discards them.

## Deleting and restoring

Deleting a Trellis project or idea in T3 Code (**Move to trash** in its settings, or **Remove** in
the sidebar's project menu) moves it to the Trellis trash and archives its conversations, without
asking first: the project stays listed as **In trash** with an **Undo** (also in the toast) until you
reload the page, after which it leaves the sidebar. Later, restore it from **Settings** > **Trellis**.
Undo and restoring also unarchive its conversations. The trash list shows when each item is removed for good.
Deleting is refused while an agent is still working in the project, and while Trellis is off or not
running. Deleting a conversation only deletes the conversation.

A discarded fork that holds work its parent workspace lacks (uncommitted changes, or commits not
merged back) is kept until you purge it; the trash says why. Agents never purge: they can ask you to,
and the trash shows the request with a **Purge** button.

## Restoring files from a turn

Reverting a turn in a Trellis project can restore its files from Trellis' snapshot of that turn. An
idea restores only its folder, so anything installed outside it (for example with `pip install
--user`) stays; install into the idea folder, such as a `.venv` there, to have it restored too. A
project restores its whole workspace, packages included, and restarts it, so agents working there
start again on their next turn. While another thread is running or has a queued turn in the same idea
or workspace, the restore is refused and names that thread; try again once it finishes. If other
threads did later work there, T3 Code names them and asks you to confirm before their changes are
undone. New turns in that idea or workspace wait until the restore finishes, and a new turn in the reverted thread waits until its revert is done. The thread then shows
the `trellis rollback` command that undoes the restore. A turn whose snapshot could not be taken
shows its checkpoint as failed, and one whose snapshot has since expired is marked missing when you
try; neither can have its files restored. Reverting without restoring files only rewinds the
conversation.

Turn diffs work in Trellis projects that are not git repositories too; they compare the two turns'
snapshots. In a git repository they come from git, so ignored files are left out.
