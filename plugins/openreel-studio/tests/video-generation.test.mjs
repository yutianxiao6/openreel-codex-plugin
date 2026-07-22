import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { once } from "node:events";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

const BRIDGE_PATH = fileURLToPath(new URL("../scripts/openreel-mcp.mjs", import.meta.url));
const LARGE_PROMPT = `giant-prompt-${"x".repeat(30_000)}`;

async function startFakeOpenReel() {
  const toolCalls = [];
  const nodeReads = [];
  const waitRequests = [];
  const projectCreateRequests = [];
  const contractRequests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
    response.setHeader("Content-Type", "application/json");

    if (request.url === "/api/health") {
      response.end(JSON.stringify({ status: "ok", app: "openreel-studio", version: "test" }));
      return;
    }
    if (request.method === "GET" && request.url === "/api/projects/project-old") {
      response.end(JSON.stringify({ id: "project-old", title: "Old project" }));
      return;
    }
    if (request.method === "POST" && request.url?.startsWith("/api/projects?")) {
      projectCreateRequests.push({ url: request.url, body });
      response.end(JSON.stringify({ id: "project-new", title: body?.title }));
      return;
    }
    if (request.url === "/api/tools/node-contract") {
      contractRequests.push(body);
      response.end(JSON.stringify({
        ok: true,
        ready: true,
        contract_version: "test.contract.v1",
        node_type: "video",
        normalized_fields: {
          prompt: body?.fields?.prompt ?? "video prompt",
          video_mode: "text_to_video",
          resolution: body?.fields?.resolution,
          generate_audio: body?.fields?.generate_audio ?? true,
        },
        provider: { api_format: "universal_adapter", protocol_id: "test.video-task" },
        capabilities: {
          supported_modes: ["text_to_video", "first_frame"],
          supports_native_audio: true,
          default_generate_audio: true,
        },
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
        response.end(JSON.stringify({
          tool: body.tool,
          result: {
            ok: true,
            id: "node-7",
            type: "video",
            status: "running",
            job_id: "job-7",
            provider_task_id: "provider-task-7",
            result: {
              prompt: LARGE_PROMPT,
              adapter_resume_request: { input: { prompt: LARGE_PROMPT } },
              polls: Array.from({ length: 100 }, (_, index) => ({ index, status: "processing" })),
            },
          },
        }));
        return;
      }
      if (body.tool === "node.update") {
        response.end(JSON.stringify({
          tool: body.tool,
          result: {
            ok: true,
            id: "node-7",
            type: "video",
            title: "Updated video",
            status: "idle",
            input: { prompt: LARGE_PROMPT, reference_images: ["node:0"] },
            changes: { input: { old: LARGE_PROMPT, new: LARGE_PROMPT } },
            output: { adapter_resume_request: { input: { prompt: LARGE_PROMPT } } },
          },
        }));
        return;
      }
      if (body.tool === "node.create") {
        response.end(JSON.stringify({
          tool: body.tool,
          result: {
            ok: true,
            id: "node-created",
            type: "video",
            title: "Created video",
            status: "idle",
            input: { prompt: LARGE_PROMPT },
          },
        }));
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
        node: {
          id: "node-7",
          type: "video",
          status: "processing",
          input: { prompt: LARGE_PROMPT },
          output: {
            job_id: "job-7",
            provider_task_id: "provider-task-7",
            prompt: LARGE_PROMPT,
            adapter_resume_request: { input: { prompt: LARGE_PROMPT } },
            media_history: Array.from({ length: 20 }, () => ({ prompt: LARGE_PROMPT })),
          },
        },
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
    projectCreateRequests,
    contractRequests,
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

test("project creation selects the new project and requests an OpenReel page reload", async () => {
  const fake = await startFakeOpenReel();
  const bridge = startBridge(fake.baseUrl);
  try {
    await bridge.call("initialize", { protocolVersion: "2025-11-25", capabilities: {} });
    await bridge.call("tools/call", {
      name: "openreel_select_project",
      arguments: { project_id: "project-old" },
    });
    const response = await bridge.call("tools/call", {
      name: "openreel_create_project",
      arguments: { title: "New project" },
    });
    const result = response.result.structuredContent;

    assert.equal(result.id, "project-new");
    assert.equal(result._codex_selected, true);
    assert.deepEqual(result.ui_activation, {
      requested: true,
      reload_page: true,
      notified_project_id: "project-old",
    });
    assert.deepEqual(fake.projectCreateRequests, [{
      url: "/api/projects?activate_ui=true&source_project_id=project-old",
      body: { title: "New project" },
    }]);
  } finally {
    await bridge.close();
    await fake.close();
  }
});

test("video tools use the 20-minute OpenReel wait contract without an old protocol tool", async () => {
  const fake = await startFakeOpenReel();
  const bridge = startBridge(fake.baseUrl);
  try {
    await bridge.call("initialize", { protocolVersion: "2025-11-25", capabilities: {} });
    const response = await bridge.call("tools/list");
    const tools = response.result.tools;
    const run = tools.find((item) => item.name === "openreel_run_node");
    const wait = tools.find((item) => item.name === "openreel_wait_for_node");
    const contract = tools.find((item) => item.name === "openreel_describe_node_contract");

    assert.equal(run.inputSchema.properties.wait_timeout_seconds.default, 1200);
    assert.equal(wait.inputSchema.properties.timeout_seconds.default, 1200);
    assert.equal(wait.inputSchema.properties.poll_interval_seconds, undefined);
    assert.ok(contract);
    assert.equal(
      tools.find((item) => item.name === "openreel_create_nodes")
        .inputSchema.properties.fields.properties.generate_audio.type,
      "boolean",
    );
    assert.match(
      tools.find((item) => item.name === "openreel_create_nodes")
        .inputSchema.properties.fields.properties.resolution.description,
      /defaults to 720p/,
    );
    assert.match(
      tools.find((item) => item.name === "openreel_create_nodes")
        .inputSchema.properties.fields.properties.generate_audio.description,
      /supports_native_audio=true/,
    );
    assert.match(
      tools.find((item) => item.name === "openreel_create_nodes").description,
      /Preflight and create/,
    );
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
    assert.equal(result.run_result.job_id, "job-7");
    assert.equal(result.run_result.provider_task_id, "provider-task-7");
    assert.equal(result.wait_result.terminal, false);
    assert.equal(result.wait_result.generation_failed, false);
    assert.equal(result.wait_result.run_continues, true);
    assert.equal(result.wait_result.next.tool, "openreel_wait_for_node");
    assert.equal(result.wait_result.next.arguments.node_id, "node-7");
    assert.equal(fake.toolCalls.filter((item) => item.tool === "node.run").length, 1);
    assert.deepEqual(fake.waitRequests, ["/api/projects/project-1/nodes/node-7/wait?timeout_seconds=1"]);
    assert.equal(fake.nodeReads.length, 0);
    const serialized = JSON.stringify(response.result);
    assert.equal(serialized.includes("giant-prompt"), false);
    assert.equal(serialized.includes("adapter_resume_request"), false);
    assert.ok(serialized.length < 5_000, `compact run result was ${serialized.length} characters`);
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
    assert.equal(response.result.structuredContent.job_id, "job-7");
    assert.equal(response.result.structuredContent.provider_task_id, "provider-task-7");
    assert.equal(fake.toolCalls.filter((item) => item.tool === "node.run").length, 0);
    assert.deepEqual(fake.waitRequests, ["/api/projects/project-1/nodes/node-7/wait?timeout_seconds=1"]);
    assert.equal(fake.nodeReads.length, 0);
    const serialized = JSON.stringify(response.result);
    assert.equal(serialized.includes("giant-prompt"), false);
    assert.ok(serialized.length < 3_500, `compact wait result was ${serialized.length} characters`);
  } finally {
    await bridge.close();
    await fake.close();
  }
});

test("node updates return identity and status without echoing large creative fields", async () => {
  const fake = await startFakeOpenReel();
  const bridge = startBridge(fake.baseUrl);
  try {
    await bridge.call("initialize", { protocolVersion: "2025-11-25", capabilities: {} });
    const response = await bridge.call("tools/call", {
      name: "openreel_update_nodes",
      arguments: {
        project_id: "project-1",
        node_id: "node-7",
        patch: { fields: { prompt: LARGE_PROMPT } },
      },
    });

    const result = response.result.structuredContent;
    assert.equal(result.ok, true);
    assert.equal(result.id, "node-7");
    assert.equal(result.status, "idle");
    assert.deepEqual(result.changed_fields, ["input"]);
    const serialized = JSON.stringify(response.result);
    assert.equal(serialized.includes("giant-prompt"), false);
    assert.ok(serialized.length < 2_500, `compact update result was ${serialized.length} characters`);
  } finally {
    await bridge.close();
    await fake.close();
  }
});

test("node creation returns a compact persisted identity", async () => {
  const fake = await startFakeOpenReel();
  const bridge = startBridge(fake.baseUrl);
  try {
    await bridge.call("initialize", { protocolVersion: "2025-11-25", capabilities: {} });
    const response = await bridge.call("tools/call", {
      name: "openreel_create_nodes",
      arguments: {
        project_id: "project-1",
        type: "video",
        fields: { prompt: LARGE_PROMPT, video_mode: "text_to_video" },
      },
    });

    const result = response.result.structuredContent;
    assert.equal(result.ok, true);
    assert.equal(result.id, "node-created");
    assert.equal(result.status, "idle");
    assert.equal(fake.contractRequests[0].fields.resolution, "720p");
    const createCall = fake.toolCalls.find((item) => item.tool === "node.create");
    assert.equal(createCall.args.fields.resolution, "720p");
    assert.equal(createCall.args.fields.generate_audio, true);
    const serialized = JSON.stringify(response.result);
    assert.equal(serialized.includes("giant-prompt"), false);
    assert.ok(serialized.length < 2_000, `compact create result was ${serialized.length} characters`);
  } finally {
    await bridge.close();
    await fake.close();
  }
});

test("an explicitly requested video resolution is preserved", async () => {
  const fake = await startFakeOpenReel();
  const bridge = startBridge(fake.baseUrl);
  try {
    await bridge.call("initialize", { protocolVersion: "2025-11-25", capabilities: {} });
    const response = await bridge.call("tools/call", {
      name: "openreel_create_nodes",
      arguments: {
        project_id: "project-1",
        type: "video",
        fields: { prompt: "explicit resolution", resolution: "1080p" },
      },
    });

    assert.equal(response.result.structuredContent.ok, true);
    assert.equal(fake.contractRequests[0].fields.resolution, "1080p");
    const createCall = fake.toolCalls.find((item) => item.tool === "node.create");
    assert.equal(createCall.args.fields.resolution, "1080p");
  } finally {
    await bridge.close();
    await fake.close();
  }
});

test("the direct node contract omits echoed prompt text", async () => {
  const fake = await startFakeOpenReel();
  const bridge = startBridge(fake.baseUrl);
  try {
    await bridge.call("initialize", { protocolVersion: "2025-11-25", capabilities: {} });
    const response = await bridge.call("tools/call", {
      name: "openreel_describe_node_contract",
      arguments: {
        project_id: "project-1",
        type: "video",
        fields: { prompt: LARGE_PROMPT, video_mode: "text_to_video" },
      },
    });

    const result = response.result.structuredContent;
    assert.equal(result.ok, true);
    assert.equal(result.ready, true);
    assert.deepEqual(result.omitted_input_fields, ["prompt"]);
    assert.deepEqual(result.capabilities.supported_modes, ["text_to_video", "first_frame"]);
    assert.equal(result.capabilities.supports_native_audio, true);
    assert.equal(result.capabilities.default_generate_audio, true);
    const serialized = JSON.stringify(response.result);
    assert.equal(serialized.includes("giant-prompt"), false);
    assert.ok(serialized.length < 3_000, `compact contract result was ${serialized.length} characters`);
  } finally {
    await bridge.close();
    await fake.close();
  }
});
