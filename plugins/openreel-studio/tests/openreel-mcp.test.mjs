import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { once } from "node:events";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";


const BRIDGE_PATH = fileURLToPath(new URL("../scripts/openreel-mcp.mjs", import.meta.url));

async function startFakeOpenReel(contractFactory, toolFactory) {
  const calls = [];
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
      response.end(JSON.stringify(contractFactory(body)));
      return;
    }
    if (request.url === "/api/tools/call") {
      calls.push(body);
      const result = toolFactory
        ? toolFactory(body)
        : { ok: true, received: body.args };
      response.end(JSON.stringify({ tool: body.tool, result }));
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
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function startBridge(baseUrl) {
  const child = spawn(process.execPath, [BRIDGE_PATH, "--stdio"], {
    env: { ...process.env, OPENREEL_BASE_URL: baseUrl },
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
    async call(method, params = {}) {
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

test("node creation uses normalized dynamic contract fields", async () => {
  const fake = await startFakeOpenReel((request) => ({
    ok: true,
    ready: true,
    contract_version: "openreel.node-contract.v1",
    normalized_fields: {
      ...request.fields,
      model: "active-image-provider",
      aspect_ratio: "16:9",
      resolution: "2560x1440",
    },
    errors: [],
  }));
  const bridge = startBridge(fake.baseUrl);
  try {
    await bridge.call("initialize", { protocolVersion: "2025-03-26", capabilities: {} });
    const response = await bridge.call("tools/call", {
      name: "openreel_create_nodes",
      arguments: {
        project_id: "project-1",
        type: "image",
        fields: { prompt: "product photo" },
      },
    });

    assert.equal(response.result.structuredContent.ok, true);
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].tool, "node.create");
    assert.deepEqual(fake.calls[0].args.fields, {
      prompt: "product photo",
      model: "active-image-provider",
      aspect_ratio: "16:9",
      resolution: "2560x1440",
    });
  } finally {
    await bridge.close();
    await fake.close();
  }
});

test("invalid contract blocks node.create before any write", async () => {
  const fake = await startFakeOpenReel(() => ({
    ok: true,
    ready: false,
    contract_version: "openreel.node-contract.v1",
    normalized_fields: { prompt: "product photo" },
    errors: [
      { field: "resolution", code: "missing_required_field", message: "缺少精确像素" },
    ],
  }));
  const bridge = startBridge(fake.baseUrl);
  try {
    await bridge.call("initialize", { protocolVersion: "2025-03-26", capabilities: {} });
    const response = await bridge.call("tools/call", {
      name: "openreel_create_nodes",
      arguments: {
        project_id: "project-1",
        type: "image",
        fields: { prompt: "product photo" },
      },
    });

    assert.equal(response.result.isError, true);
    assert.equal(response.result.structuredContent.error_kind, "node_contract_failed");
    assert.equal(response.result.structuredContent.contract.errors[0].field, "resolution");
    assert.equal(fake.calls.length, 0);
  } finally {
    await bridge.close();
    await fake.close();
  }
});

test("run preflight blocks provider execution and keeps the existing node", async () => {
  const fake = await startFakeOpenReel(
    () => ({
      ok: true,
      ready: false,
      contract_version: "openreel.node-contract.v1",
      normalized_fields: { prompt: "video prompt", duration_seconds: 8 },
      errors: [
        { field: "duration_seconds", code: "unsupported_value", supported: [5, 10] },
      ],
    }),
    (request) => {
      if (request.tool === "node.get") {
        return {
          id: "#7",
          type: "video",
          input: { prompt: "video prompt", duration_seconds: 8 },
        };
      }
      return { ok: true };
    },
  );
  const bridge = startBridge(fake.baseUrl);
  try {
    await bridge.call("initialize", { protocolVersion: "2025-03-26", capabilities: {} });
    const response = await bridge.call("tools/call", {
      name: "openreel_run_node",
      arguments: { project_id: "project-1", node_id: "#7" },
    });

    assert.equal(response.result.isError, true);
    assert.equal(response.result.structuredContent.error_kind, "node_run_preflight_failed");
    assert.equal(response.result.structuredContent.node_id, "#7");
    assert.deepEqual(fake.calls.map((item) => item.tool), ["node.get"]);
  } finally {
    await bridge.close();
    await fake.close();
  }
});
