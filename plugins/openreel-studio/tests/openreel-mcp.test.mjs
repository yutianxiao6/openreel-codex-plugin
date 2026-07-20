import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { once } from "node:events";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";


const BRIDGE_PATH = fileURLToPath(new URL("../scripts/openreel-mcp.mjs", import.meta.url));

async function startFakeOpenReel(contractFactory, toolFactory, requestFactory) {
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
    if (requestFactory) {
      const result = await requestFactory({ method: request.method, url: request.url, body });
      if (result !== undefined) {
        response.end(JSON.stringify(result));
        return;
      }
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

test("tool surface exposes only the compact canvas control profile", async () => {
  const fake = await startFakeOpenReel(() => ({ ok: true, ready: true, normalized_fields: {}, errors: [] }));
  const bridge = startBridge(fake.baseUrl);
  try {
    await bridge.call("initialize", { protocolVersion: "2025-03-26", capabilities: {} });
    const response = await bridge.call("tools/list");
    const names = response.result.tools.map((item) => item.name);

    assert.deepEqual(new Set(names), new Set([
      "openreel_connection_info",
      "openreel_list_projects",
      "openreel_get_canvas",
      "openreel_describe_node_contract",
      "openreel_apply_canvas_patch",
      "openreel_delete_canvas_items",
      "openreel_run_nodes",
      "openreel_upload_node_media",
    ]));
    assert.equal(names.length, 8);
    assert.ok(JSON.stringify(response.result.tools).length < 18_000, "public tool schema budget exceeded");

    const hiddenCall = await bridge.call("tools/call", {
      name: "openreel_create_nodes",
      arguments: { project_id: "project-1", type: "text", fields: { content: "hidden" } },
    });
    assert.match(hiddenCall.error.message, /Unknown or private tool/);
  } finally {
    await bridge.close();
    await fake.close();
  }
});

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
      name: "openreel_apply_canvas_patch",
      arguments: {
        project_id: "project-1",
        operations: [{ op: "create_node", type: "image", fields: { prompt: "product photo" } }],
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
      name: "openreel_apply_canvas_patch",
      arguments: {
        project_id: "project-1",
        operations: [{ op: "create_node", type: "image", fields: { prompt: "product photo" } }],
      },
    });

    assert.equal(response.result.isError, true);
    const failure = response.result.structuredContent.results[0].result;
    assert.equal(failure.error_kind, "node_contract_failed");
    assert.equal(failure.contract.errors[0].field, "resolution");
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
      name: "openreel_run_nodes",
      arguments: { project_id: "project-1", runs: [{ node_id: "#7" }] },
    });

    assert.equal(response.result.isError, true);
    const failure = response.result.structuredContent.results[0].result;
    assert.equal(failure.error_kind, "node_run_preflight_failed");
    assert.equal(failure.node_id, "#7");
    assert.deepEqual(fake.calls.map((item) => item.tool), ["node.get"]);
  } finally {
    await bridge.close();
    await fake.close();
  }
});

test("persistent canvas layout, edge, history, and snapshot operations use atomic APIs", async () => {
  const restCalls = [];
  const fake = await startFakeOpenReel(
    () => ({ ok: true, ready: true, normalized_fields: {}, errors: [] }),
    (request) => {
      if (request.tool === "node.get") {
        return {
          id: request.args.node_id,
          _canvas_id: `internal-${String(request.args.node_id).replace(/^#/, "")}`,
          type: "image",
          input: { prompt: "source" },
        };
      }
      return { ok: true };
    },
    ({ method, url, body }) => {
      restCalls.push({ method, url, body });
      return { ok: true, id: url.split("/").pop(), ...body };
    },
  );
  const bridge = startBridge(fake.baseUrl);
  try {
    await bridge.call("initialize", { protocolVersion: "2025-03-26", capabilities: {} });
    const patchResponse = await bridge.call("tools/call", {
      name: "openreel_apply_canvas_patch",
      arguments: {
        project_id: "project-1",
        operations: [
          { op: "move_node", node_id: "#1", x: 120, y: 80 },
          { op: "move_node", node_id: "#2", x: 520, y: 80 },
          { op: "update_edge", edge_id: "edge-1", label: "visual reference" },
          { op: "switch_node_history", node_id: "#2", history_id: "history-1" },
        ],
      },
    });
    assert.equal(patchResponse.result.structuredContent.ok, true);
    const destructiveResponse = await bridge.call("tools/call", {
      name: "openreel_delete_canvas_items",
      arguments: {
        project_id: "project-1",
        edge_ids: ["edge-2"],
        restore_snapshot: {
          nodes: [{ id: "restored-1", type: "text", title: "Restored" }],
          edges: [],
        },
        confirm: true,
      },
    });
    assert.equal(destructiveResponse.result.structuredContent.ok, true);

    assert.deepEqual(
      restCalls.map((item) => [item.method, item.url]),
      [
        ["PATCH", "/api/projects/project-1/nodes/internal-1/position"],
        ["PATCH", "/api/projects/project-1/nodes/internal-2/position"],
        ["PATCH", "/api/projects/project-1/edges/edge-1"],
        ["POST", "/api/projects/project-1/nodes/internal-2/history/switch"],
        ["DELETE", "/api/projects/project-1/edges/edge-2"],
        ["POST", "/api/projects/project-1/canvas/restore-snapshot"],
      ],
    );
    assert.deepEqual(restCalls[0].body, { x: 120, y: 80 });
    assert.deepEqual(restCalls[2].body, { label: "visual reference" });
    assert.deepEqual(restCalls[3].body, { history_id: "history-1" });
  } finally {
    await bridge.close();
    await fake.close();
  }
});

test("node duplication keeps creative fields, drops generated upload state, and offsets layout", async () => {
  const restCalls = [];
  const fake = await startFakeOpenReel(
    (request) => ({
      ok: true,
      ready: true,
      normalized_fields: request.fields,
      errors: [],
    }),
    (request) => {
      if (request.tool === "node.get" && request.args.node_id === "#3") {
        return {
          id: "#3",
          _canvas_id: "source-3",
          type: "image",
          title: "Hero frame",
          prompt: "cinematic hero",
          input: {
            prompt: "cinematic hero",
            aspect_ratio: "16:9",
            resolution: "2560x1440",
            uploaded_output: { url: "/old.png" },
            render_state: "fresh",
          },
          position: { x: 300, y: 200 },
        };
      }
      if (request.tool === "node.create") {
        return { ok: true, id: "#4", _canvas_id: "copy-4", type: "image", input: request.args.fields };
      }
      if (request.tool === "node.get" && request.args.node_id === "copy-4") {
        return { id: "#4", _canvas_id: "copy-4", type: "image", input: {} };
      }
      return { ok: false, error: "unexpected tool call" };
    },
    ({ method, url, body }) => {
      restCalls.push({ method, url, body });
      return { ok: true, id: "copy-4", position: body };
    },
  );
  const bridge = startBridge(fake.baseUrl);
  try {
    await bridge.call("initialize", { protocolVersion: "2025-03-26", capabilities: {} });
    const response = await bridge.call("tools/call", {
      name: "openreel_apply_canvas_patch",
      arguments: {
        project_id: "project-1",
        operations: [{ op: "duplicate_node", node_id: "#3", offset_x: 60, offset_y: 40 }],
      },
    });

    assert.equal(response.result.structuredContent.ok, true);
    const createCall = fake.calls.find((item) => item.tool === "node.create");
    assert.equal(createCall.args.fields.title, "Hero frame 副本");
    assert.equal(createCall.args.fields.uploaded_output, undefined);
    assert.equal(createCall.args.fields.render_state, undefined);
    assert.deepEqual(restCalls, [{
      method: "PATCH",
      url: "/api/projects/project-1/nodes/copy-4/position",
      body: { x: 360, y: 240 },
    }]);
  } finally {
    await bridge.close();
    await fake.close();
  }
});
