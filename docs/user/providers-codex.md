# Codex

For one account, use the default Codex provider with your normal Codex login.
[Provider setup](./install.md#providers) covers installation, Settings > Providers,
and custom binaries or environment variables.

## Import existing conversations

Open **Import conversations** in a project's settings or from the sidebar while
that project is selected. On mobile, use **Settings > Import Codex Chats**. Choose
the Codex account on the environment that holds the conversations, then browse or
search and import an individual conversation. Enable archived conversations to
find older archived work; importing one restores it in Codex.

Finish work in the original client before importing. Import does not synchronize
with a conversation still running elsewhere. Keep its original project folder, or
explicitly choose to continue in the selected project's folder.

The conversation keeps its Codex context when you continue it in T3 Code. Open
**Original Codex history** above the chat to read its earlier messages and tool
results, and load older pages as needed. Conversations previously imported through
onboarding can use **Load full history** in the import picker. The original-history
panel replaces their short imported text preview while open; new T3 messages stay
in the chat.

**Import recent conversations** remains available for the previous batch import:
it selects recent Claude/Codex conversations and retains a limited text preview.
Use individual Codex import for complete, paginated history.

## Ask Codex to start another chat

Ask explicitly, for example: “Start a separate chat to review the parser, and keep
working on the UI here.” Approve the task action when prompted. The new chat appears
in the same project's sidebar and uses the current workspace, Codex account, model,
and permission mode. It shares that workspace; it does not create a new worktree.

You can open the new chat and continue it yourself, or ask the original agent to
read its progress and send a follow-up. Messages sent by another agent are labeled
in the receiving chat. Each chat handles its own questions and approvals.

**Agent task access** in Settings controls these tools for new Codex sessions,
independently of browser access. Task tools operate within the current T3 project;
other providers do not yet receive agent-authored task messages.

## Use multiple accounts

A shared Codex home with a shadow home lets work and personal accounts continue
the same threads. The accounts share Codex sessions and configuration while keeping
their own login and available models.

Keep your first account in `~/.codex`. On the environment's machine, sign the
second account into a fresh directory:

```bash
mkdir -p ~/.codex_personal
CODEX_HOME=~/.codex_personal codex login
```

Then add a second Codex instance in **Settings > Providers**:

| Instance       | CODEX_HOME path | Shadow home path    |
| -------------- | --------------- | ------------------- |
| Codex Work     | `~/.codex`      | Leave empty         |
| Codex Personal | `~/.codex`      | `~/.codex_personal` |

Both instances must use the same **CODEX_HOME path**. T3 Code prepares the shared
state in the shadow directory; do not populate it by copying your whole Codex
home.

The shadow account needs its own `auth.json` file. If Codex uses an OS credential
store, configure file storage for this setup. See
[OpenAI's credential storage guide](https://learn.chatgpt.com/docs/auth#credential-storage).

Use a completely separate **CODEX_HOME path**, with no shadow home, when you want
separate Codex sessions and configuration. That instance cannot continue threads
from the other home.

## Switch accounts in an existing thread

Choose the other account from the thread's model picker. T3 Code offers compatible
Codex instances that share the thread's **CODEX_HOME path**. Changing accounts does
not move the conversation into a separate Codex home.

If the account is missing from the picker, compare the home paths in provider
settings. If two instances show the same unexpected account or models, check their
reported accounts, refresh provider status, and confirm the second instance has
its own shadow path and login. A shadow-home conflict usually means the directory
contains a copied Codex setup. Use a fresh shadow directory and sign in again.

## Answer questions while Codex works

Codex can ask a question and keep working. Answer it in the thread's question
panel. The answer becomes a new message: it reaches the active turn, or starts
another turn if Codex has finished. Unanswered questions survive reconnects.
If you do not want to answer, dismiss the question from its panel. Dismissing
closes it without sending anything to Codex. This requires a Codex version that
supports async questions.

## Approve app access

Codex tools can request access to another app. Respond to the named app's request
in the thread on web, desktop, or mobile. Some tools offer access for one request,
the current session, or permanently. See [Permission modes](./permission-modes.md)
for command and file approvals.

## Codex says I hit a usage limit

When Codex stops on a usage limit, the thread names the window that ran out and
when it resets, when Codex reports them. Send the message again after the reset. On a workspace plan the
message also says whether your workspace owner needs to add credits or raise the
spend limit to continue sooner.

## Send feedback to OpenAI

In an existing Codex thread, send `/feedback` with an optional description, for
example `/feedback The agent stopped before finishing the tests`. This uploads
the conversation and Codex logs to OpenAI. The returned thread ID can be shared
with OpenAI support.
