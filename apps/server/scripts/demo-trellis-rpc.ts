// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalConsole:off preferSchemaOverJson:off - A host-side demo helper that prints raw RPC results.
/**
 * Calls one WebSocket RPC of a running dev server as a paired browser would,
 * for `scripts/demo-trellis.sh`. Authenticates with the browser's session
 * cookie (from `T3_DEMO_COOKIE`, never an argument, so it stays out of logs)
 * and prints the result as JSON, or the failure and exit code 1.
 *
 *   node apps/server/scripts/demo-trellis-rpc.ts <origin> <method> '<json payload>'
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Socket } from "effect/unstable/socket";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import {
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION,
  WsRpcGroup,
} from "@t3tools/contracts";

const [origin, method, payloadJson] = process.argv.slice(2);
const cookie = process.env.T3_DEMO_COOKIE;
if (!origin || !method || !payloadJson || !cookie) {
  console.error("usage: T3_DEMO_COOKIE=... demo-trellis-rpc.ts <origin> <method> '<json payload>'");
  process.exit(2);
}

const ticketResponse = await fetch(`${origin}/api/auth/websocket-ticket`, {
  method: "POST",
  headers: {
    Cookie: cookie,
    [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION),
  },
});
if (!ticketResponse.ok) {
  console.error(`websocket ticket: ${ticketResponse.status} ${await ticketResponse.text()}`);
  process.exit(1);
}
const { ticket } = (await ticketResponse.json()) as { ticket: string };

const socket = Socket.layerWebSocket(
  `${origin.replace(/^http/, "ws")}/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}&wsTicket=${encodeURIComponent(ticket)}`,
).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal));
const protocol = RpcClient.layerProtocolSocket().pipe(
  Layer.provide(socket),
  Layer.provide(RpcSerialization.layerJson),
);

if (!WsRpcGroup.requests.has(method)) {
  console.error(`unknown method ${method}`);
  process.exit(2);
}

const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(WsRpcGroup);
  const call = (client as unknown as Record<string, (payload: unknown) => Effect.Effect<unknown>>)[
    method
  ]!;
  return yield* call(JSON.parse(payloadJson));
});

const exit = await Effect.runPromiseExit(
  program.pipe(Effect.scoped, Effect.provide(protocol), Effect.timeout("30 seconds")),
);
if (exit._tag === "Success") {
  console.log(JSON.stringify(exit.value, null, 2));
  process.exit(0);
}
console.error(String(exit.cause));
process.exit(1);
