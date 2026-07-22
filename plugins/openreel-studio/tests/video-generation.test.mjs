import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { once } from "node:events";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

const BRIDGE_PATH = fileURLToPath(new URL("../scripts/openreel-mcp.mjs", import.meta.url));

async function startFakeOpenReel() {
  const toolCalls = [];
  const nodeReads = [];
  const waitRequests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
    response.setHeader("Content-Type", "application/json");

    if (request.url === "/api/health") {
      response.end(JSON.stringify({ status: "ok", app: "openreel-studio", version: "test" }));
      return;
    }
    if (request.url === "/api/tools/node-contract") {
      response.end(JSON.stringify({
        ok: true,
        ready: true,
        normalized_fields: { prompt: "video prompt", video_mode: "text_to_video" },
        provider: { api_format: "universal_adapter", protocol_id: "test.video-task" },
        errors: [],
      }));
      return;
    }
    if (request.url === "/api/tools/call") {
      toolCalls.push(body);
      if (body.tool === "node.get") {
        response.end(JSON.stringify({
          tool: body.tool,
          result: { id: body.args.node_id, type: "video", fields: { prompt: "video prompt" } },
        }));
        return;
      }
      if (body.tool === "node.run") {
        response.end(JSON.stringify({ tool: body.tool, result: { ok: true, id: "node-7" } }));
        return;
      }
    }
    if (request.method === "GET" && request.url === "/api/projects/project-1/nodes/node-7") {
      nodeReads.push(request.url);
      response.end(JSON.stringify({ id: "node-7", type: "video", status: "processing" }));
      return;
    }
    if (request.method === "GET" && request.url?.startsWith("/api/projects/project-1/nodes/node-7/wait?")) {
      waitRequests.push(request.url);
      response.end(JSON.stringify({
        ok: true,
        terminal: false,
        generation_failed: false,
        run_continues: true,
        status: "processing",
        node: { id: "node-7", type: "video", status: "processing" },
      }));
      return;
    }

    response.statusCode = 404;
    response.end(JSON.stringify({ detail: "not found" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    toolCalls,
    nodeReads,
    waitRequests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function startBridge(baseUrl) {
  const env = { ...process.env };
  for (const name of [
    "OPENREEL_USERNAME",
    "OPENREEL_PASSWORD",
    "OPENREEL_TOKEN",
    "OPENREEL_CONFIG_PATH",
  ]) delete env[name];
  Object.assign(env, {
    OPENREEL_BASE_URL: baseUrl,
    OPENREEL_REMEMBER_CONNECTION: "0",
  });
  const child = spawn(process.execPath, [BRIDGE_PATH, "--stdio"], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  const stderr = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    const resolve = pending.get(message.id);
    if (resolve) {
      pending.delete(message.id);
      resolve(message);
    }
  });
  child.stderr.on("data", (chunk) => stderr.push(chunk.toString("utf8")));
  let nextId = 1;
  return {
    call(method, params = {}) {
      const id = nextId++;
      const result = new Promise((resolve) => pending.set(id, resolve));
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return result;
    },
    async close() {
      child.kill("SIGTERM");
      await once(child, "exit");
      assert.equal(stderr.join(""), "");
    },
  };
}

test("video tools use the 20-minute OpenReel wait contract without an old protocol tool", async () => {
  const fake = await startFakeOpenReel();
  const bridge = startBridge(fake.baseUrl);
  try {
    await bridge.call("initialize", { protocolVersion: "2025-11-25", capabilities: {} });
    const response = await bridge.call("tools/list");
    const tools = response.result.tools;
    const run = tools.find((item) => item.name === "openreel_run_node");
    const wait = tools.find((item) => item.name === "openreel_wait_for_node");

    assert.equal(run.inputSchema.properties.wait_timeout_seconds.default, 1200);
    assert.equal(wait.inputSchema.properties.timeout_seconds.default, 1200);
    assert.equal(wait.inputSchema.properties.poll_interval_seconds, undefined);
    assert.equal(tools.some((item) => item.name === "openreel_list_media_protocols"), false);
  } finally {
    await bridge.close();
    await fake.close();
  }
});

test("a video wait timeout preserves the running node and never submits twice", async () => {
  const fake = await startFakeOpenReel();
  const bridge = startBridge(fake.baseUrl);
  try {
    await bridge.call("initialize", { protocolVersion: "2025-11-25", capabilities: {} });
    const response = await bridge.call("tools/call", {
      name: "openreel_run_node",
      arguments: {
        project_id: "project-1",
        node_id: "node-7",
        wait_timeout_seconds: 1,
      },
    });
    const result = response.result.structuredContent;

    assert.equal(response.result.isError, undefined);
    assert.equal(result.ok, true);
    assert.equal(result.run_result.ok, true);
    assert.equal(result.wait_result.terminal, false);
    assert.equal(result.wait_result.generation_failed, false);
    assert.equal(result.wait_result.run_continues, true);
    assert.equal(result.wait_result.next.tool, "openreel_wait_for_node");
    assert.equal(result.wait_result.next.arguments.node_id, "node-7");
    assert.equal(fake.toolCalls.filter((item) => item.tool === "node.run").length, 1);
    assert.deepEqual(fake.waitRequests, ["/api/projects/project-1/nodes/node-7/wait?timeout_seconds=1"]);
    assert.equal(fake.nodeReads.length, 0);
  } finally {
    await bridge.close();
    await fake.close();
  }
});

test("the direct wait tool holds one server wait without running the node", async () => {
  const fake = await startFakeOpenReel();
  const bridge = startBridge(fake.baseUrl);
  try {
    await bridge.call("initialize", { protocolVersion: "2025-11-25", capabilities: {} });
    const response = await bridge.call("tools/call", {
      name: "openreel_wait_for_node",
      arguments: {
        project_id: "project-1",
        node_id: "node-7",
        timeout_seconds: 1,
      },
    });

    assert.equal(response.result.isError, undefined);
    assert.equal(response.result.structuredContent.terminal, false);
    assert.equal(fake.toolCalls.filter((item) => item.tool === "node.run").length, 0);
    assert.deepEqual(fake.waitRequests, ["/api/projects/project-1/nodes/node-7/wait?timeout_seconds=1"]);
    assert.equal(fake.nodeReads.length, 0);
  } finally {
    await bridge.close();
    await fake.close();
  }
});
