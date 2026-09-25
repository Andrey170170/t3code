# Trellis workspaces

Trellis runs projects in isolated workspaces with
snapshots, so an agent can change a whole environment and you can roll it back. Quick ideas live as
folders in a shared scratch workspace; Trellis projects get workspaces of their own. T3 Code shows
each idea, project and fork as a project in the sidebar and runs Codex and Claude inside the
workspace.

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
nothing behind. The idea is named from the conversation.

**New Trellis project** in the command palette creates a project right away, optionally from a git
repository. **Find in Trellis** searches ideas and projects and opens the workspace that matched,
including forks.

## Deleting and restoring

Deleting a Trellis project or idea in T3 Code moves it to the Trellis trash and archives its
conversations. Restore it from **Settings** > **Trellis**; restoring also unarchives its
conversations. Ideas in the trash are removed after 30 days; projects stay until you empty the
trash. Deleting a conversation only deletes the conversation.

## Restoring files from a turn

Rewinding a thread in a Trellis project can restore its files from Trellis' snapshot of that turn.
An idea restores only its folder; a project restores its whole workspace and restarts it. The restore
waits while another thread is working in the same idea or workspace. If Trellis could not snapshot a
turn, the thread says so and that turn cannot be restored.
