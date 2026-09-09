import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => write({ method, params });
const thread = (id) => ({
  id,
  cliVersion: "test",
  createdAt: 1,
  updatedAt: 1,
  cwd: process.cwd(),
  ephemeral: id === "side",
  modelProvider: "openai",
  preview: "",
  sessionId: id,
  source: "appServer",
  status: { type: "idle" },
  turns: [
    {
      id: "parent-turn",
      status: "completed",
      items: [{ type: "agentMessage", id: "parent-answer", text: "Parent history" }],
    },
  ],
});
const opened = (id) => ({
  thread: thread(id),
  model: "gpt-5.3-codex",
  modelProvider: "openai",
  cwd: process.cwd(),
  approvalPolicy: "on-request",
  approvalsReviewer: "user",
  sandbox: { type: "readOnly" },
  reasoningEffort: "high",
});
let pendingTurn;
let turnCount = 0;
let boundary = false;
for await (const line of NodeReadline.createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (!message.method) {
    if (message.id === "side-approval") {
      notify("item/agentMessage/delta", {
        threadId: "side",
        turnId: pendingTurn,
        itemId: "answer",
        delta: "Side answer",
      });
      notify("turn/completed", {
        threadId: "side",
        turn: { id: pendingTurn, status: "completed", items: [] },
      });
    }
    continue;
  }
  NodeFS.appendFileSync(process.env.SIDE_TEST_LOG, `${JSON.stringify(message)}\n`);
  const respond = (result) => write({ id: message.id, result });
  switch (message.method) {
    case "initialize":
      respond({
        userAgent: "test",
        codexHome: process.cwd(),
        platformFamily: "unix",
        platformOs: "linux",
      });
      break;
    case "initialized":
      break;
    case "thread/start":
      respond(opened("parent"));
      break;
    case "config/read":
      respond({ config: { developer_instructions: "Existing developer policy." }, origins: {} });
      break;
    case "thread/fork":
      notify("thread/started", { thread: thread("side") });
      respond(opened("side"));
      break;
    case "thread/inject_items":
      boundary = true;
      if (process.env.SIDE_TEST_FAIL_INJECT)
        write({ id: message.id, error: { code: -32603, message: "Injection failed" } });
      else respond({});
      break;
    case "turn/start": {
      if (!boundary) throw new Error("Side input must follow the injected boundary");
      pendingTurn = ++turnCount === 1 ? "side-turn" : `side-turn-${turnCount}`;
      const turn = { id: pendingTurn, status: "inProgress", items: [] };
      respond({ turn });
      notify("turn/started", { threadId: "side", turn });
      if (message.params.input[0]?.text !== "hold") {
        write({
          id: "side-approval",
          method: "item/commandExecution/requestApproval",
          params: {
            startedAtMs: 1,
            threadId: "side",
            turnId: pendingTurn,
            itemId: "command",
            command: "pwd",
            cwd: process.cwd(),
          },
        });
      }
      break;
    }
    case "thread/resume":
      {
        const result = opened(message.params.threadId);
        result.thread.turns.push({
          id: "side-turn",
          status: "completed",
          startedAt: 1740000000,
          completedAt: 1740000010,
          items: [{ type: "agentMessage", id: "replay-answer", text: "Completed while detached" }],
        });
        respond(result);
      }
      break;
    case "turn/interrupt":
      respond({});
      break;
    case "thread/unsubscribe":
      respond({ status: "unsubscribed" });
      break;
    default:
      write({ id: message.id, error: { code: -32601, message: `Unhandled ${message.method}` } });
  }
}
