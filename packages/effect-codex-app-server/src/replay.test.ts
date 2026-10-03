import { describe, expect, it } from "vite-plus/test";

import { normalizeThreadRequest } from "./replay.ts";

describe("normalizeThreadRequest", () => {
  it("leaves out host-supplied MCP servers, nested or as dotted keys", () => {
    const frame = (config: Record<string, unknown>) => ({
      method: "thread/start",
      params: { cwd: "/w", model: "m", config: { "tools.update_plan.enabled": true, ...config } },
    });
    const expected = {
      method: "thread/start",
      params: { config: { "tools.update_plan.enabled": true } },
    };
    const server = { url: "http://127.0.0.1:1/mcp", http_headers: { Authorization: "Bearer x" } };
    expect(
      normalizeThreadRequest(frame({ mcp_servers: { "t3-code": server } }), new Set()),
    ).toEqual(expected);
    expect(normalizeThreadRequest(frame({ "mcp_servers.t3-code": server }), new Set())).toEqual(
      expected,
    );
    expect(normalizeThreadRequest(frame({}), new Set())).toEqual(expected);
  });
});
