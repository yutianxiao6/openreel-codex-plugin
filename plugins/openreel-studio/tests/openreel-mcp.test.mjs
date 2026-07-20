import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";


const BRIDGE_PATH = fileURLToPath(new URL("../scripts/openreel-mcp.mjs", import.meta.url));
const MCP_MANIFEST_PATH = fileURLToPath(new URL("../.mcp.json", import.meta.url));
const FORWARDED_ENV_VARS = [
  "OPENREEL_BASE_URL",
  "OPENREEL_USERNAME",
  "OPENREEL_PASSWORD",
  "OPENREEL_TOKEN",
  "OPENREEL_DISCOVERY_PORTS",
  "OPENREEL_REQUEST_TIMEOUT_MS",
  "OPENREEL_CONFIG_PATH",
  "OPENREEL_REMEMBER_CONNECTION",
];

async function startFakeOpenReel(contractFactory, toolFactory, requestFactory) {
  const calls = [];
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
    requests.push({ method: request.method, url: request.url, headers: request.headers, body });
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
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("plugin manifest forwards optional OpenReel settings without embedding secret values", async () => {
  const manifest = JSON.parse(await readFile(MCP_MANIFEST_PATH, "utf8"));
  const server = manifest.mcpServers?.["openreel-studio"];

  assert.deepEqual(server.env_vars, FORWARDED_ENV_VARS);
  assert.equal(server.env, undefined);
});

test("bridge supports unauthenticated, Basic, and Bearer connections", async (t) => {
  const cases = [
    { name: "none", env: {}, expected: undefined },
    {
      name: "basic",
      env: { OPENREEL_USERNAME: "test-user", OPENREEL_PASSWORD: "test-password" },
      expected: `Basic ${Buffer.from("test-user:test-password").toString("base64")}`,
    },
    { name: "bearer", env: { OPENREEL_TOKEN: "test-token" }, expected: "Bearer test-token" },
  ];

  for (const authCase of cases) {
    await t.test(authCase.name, async () => {
      const fake = await startFakeOpenReel(() => ({ ok: true, ready: true, normalized_fields: {}, errors: [] }));
      const bridge = startBridge(fake.baseUrl, authCase.env);
      try {
        await bridge.call("initialize", { protocolVersion: "2025-03-26", capabilities: {} });
        const response = await bridge.call("tools/call", {
          name: "openreel_connection_info",
          arguments: { refresh: true },
        });
        const healthRequest = fake.requests.find((request) => request.url === "/api/health");
        assert.equal(healthRequest?.headers.authorization, authCase.expected);
        assert.equal(response.result.structuredContent.authentication, authCase.name);
      } finally {
        await bridge.close();
        await fake.close();
      }
    });
  }
});

test("a verified connection is saved privately and reused without environment credentials", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "openreel-connection-test-"));
  const configPath = path.join(directory, "connection.json");
  const fake = await startFakeOpenReel(() => ({ ok: true, ready: true, normalized_fields: {}, errors: [] }));
  try {
    const firstBridge = startBridge(fake.baseUrl, {
      OPENREEL_USERNAME: "remembered-user",
      OPENREEL_PASSWORD: "remembered-password",
      OPENREEL_CONFIG_PATH: configPath,
      OPENREEL_REMEMBER_CONNECTION: "1",
    });
    try {
      await firstBridge.call("initialize", { protocolVersion: "2025-03-26", capabilities: {} });
      const first = await firstBridge.call("tools/call", {
        name: "openreel_connection_info",
        arguments: { refresh: true },
      });
      assert.equal(first.result.structuredContent.settings_source, "environment");
      assert.equal(first.result.structuredContent.connection_saved, true);
      assert.equal(first.result.structuredContent.authentication, "basic");
      assert.equal(JSON.stringify(first.result).includes("remembered-password"), false);
    } finally {
      await firstBridge.close();
    }

    const saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(saved.base_url, fake.baseUrl);
    assert.deepEqual(saved.authentication, {
      type: "basic",
      username: "remembered-user",
      password: "remembered-password",
    });
    if (process.platform !== "win32") assert.equal((await stat(configPath)).mode & 0o777, 0o600);

    fake.requests.length = 0;
    const secondBridge = startBridge(undefined, {
      OPENREEL_CONFIG_PATH: configPath,
      OPENREEL_REMEMBER_CONNECTION: "0",
    });
    try {
      await secondBridge.call("initialize", { protocolVersion: "2025-03-26", capabilities: {} });
      const second = await secondBridge.call("tools/call", {
        name: "openreel_connection_info",
        arguments: { refresh: true },
      });
      assert.equal(second.result.structuredContent.source, "saved-config");
      assert.equal(second.result.structuredContent.settings_source, "saved-config");
      assert.equal(second.result.structuredContent.connection_saved, true);
      assert.equal(second.result.structuredContent.authentication, "basic");
      assert.equal(
        fake.requests.find((request) => request.url === "/api/health")?.headers.authorization,
        `Basic ${Buffer.from("remembered-user:remembered-password").toString("base64")}`,
      );
    } finally {
      await secondBridge.close();
    }

    fake.requests.length = 0;
    const replacementBridge = startBridge(fake.baseUrl, {
      OPENREEL_CONFIG_PATH: configPath,
      OPENREEL_REMEMBER_CONNECTION: "1",
    });
    try {
      await replacementBridge.call("initialize", { protocolVersion: "2025-03-26", capabilities: {} });
      const replacement = await replacementBridge.call("tools/call", {
        name: "openreel_connection_info",
        arguments: { refresh: true },
      });
      assert.equal(replacement.result.structuredContent.authentication, "none");
      assert.equal(fake.requests.find((request) => request.url === "/api/health")?.headers.authorization, undefined);
      assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")).authentication, { type: "none" });
    } finally {
      await replacementBridge.close();
    }
  } finally {
    await fake.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("tool surface loads common CRUD directly and defers uncommon capabilities", async () => {
  const fake = await startFakeOpenReel(() => ({ ok: true, ready: true, normalized_fields: {}, errors: [] }));
  const bridge = startBridge(fake.baseUrl);
  try {
    await bridge.call("initialize", { protocolVersion: "2025-03-26", capabilities: {} });
    const response = await bridge.call("tools/list");
    const names = response.result.tools.map((item) => item.name);

    assert.deepEqual(new Set(names), new Set([
      "openreel_connection_info",
      "openreel_list_projects",
      "openreel_select_project",
      "openreel_create_project",
      "openreel_get_project",
      "openreel_update_project",
      "openreel_delete_project",
      "openreel_get_canvas",
      "openreel_get_nodes",
      "openreel_create_nodes",
      "openreel_update_nodes",
      "openreel_move_nodes",
      "openreel_delete_nodes",
      "openreel_connect_nodes",
      "openreel_update_edges",
      "openreel_delete_edges",
      "openreel_run_node",
      "openreel_upload_node_media",
      "openreel_search_capabilities",
      "openreel_describe_capability",
      "openreel_execute_capability",
      "openreel_execute_destructive_capability",
    ]));
    assert.equal(names.length, 22);
    assert.ok(JSON.stringify(response.result.tools).length < 30_000, "public tool schema budget exceeded");
    const createProject = response.result.tools.find((item) => item.name === "openreel_create_project");
    assert.deepEqual(Object.keys(createProject.inputSchema.properties), ["title"]);
    assert.deepEqual(createProject.inputSchema.required, ["title"]);
    const updateProject = response.result.tools.find((item) => item.name === "openreel_update_project");
    assert.deepEqual(Object.keys(updateProject.inputSchema.properties), ["project_id", "title"]);
    assert.deepEqual(updateProject.inputSchema.required, ["title"]);
    for (const name of [
      "openreel_get_project",
      "openreel_update_project",
      "openreel_delete_project",
      "openreel_get_canvas",
      "openreel_get_nodes",
      "openreel_create_nodes",
      "openreel_update_nodes",
      "openreel_move_nodes",
      "openreel_delete_nodes",
      "openreel_connect_nodes",
      "openreel_update_edges",
      "openreel_delete_edges",
      "openreel_run_node",
      "openreel_upload_node_media",
      "openreel_execute_capability",
      "openreel_execute_destructive_capability",
    ]) {
      const tool = response.result.tools.find((item) => item.name === name);
      assert.equal(tool.inputSchema.required.includes("project_id"), false, `${name} still requires project_id`);
    }

    const search = await bridge.call("tools/call", {
      name: "openreel_search_capabilities",
      arguments: { query: "切换历史图片" },
    });
    const match = search.result.structuredContent.matches.find((item) => item.capability === "node.history.switch");
    assert.equal(match.capability, "node.history.switch");
    assert.equal(match.input_schema, undefined);

    const described = await bridge.call("tools/call", {
      name: "openreel_describe_capability",
      arguments: { capability: "node.duplicate" },
    });
    assert.equal(described.result.structuredContent.executor, "openreel_execute_capability");
    assert.equal(JSON.stringify(described.result.structuredContent.input_schema).includes("project_id"), false);
    assert.match(described.result.structuredContent.schema_ref, /node\.duplicate:[a-f0-9]{12}$/);

    const staleSchema = await bridge.call("tools/call", {
      name: "openreel_execute_capability",
      arguments: {
        project_id: "project-1",
        capability: "node.duplicate",
        schema_ref: "stale",
        arguments: { node_ids: ["#1"] },
      },
    });
    assert.equal(staleSchema.result.isError, true);
    assert.equal(staleSchema.result.structuredContent.error_kind, "capability_description_required");

    const invalidArguments = await bridge.call("tools/call", {
      name: "openreel_execute_capability",
      arguments: {
        project_id: "project-1",
        capability: "node.duplicate",
        schema_ref: described.result.structuredContent.schema_ref,
        arguments: { node_ids: ["#1"], offset_x: "ten" },
      },
    });
    assert.equal(invalidArguments.result.isError, true);
    assert.equal(invalidArguments.result.structuredContent.error_kind, "capability_arguments_invalid");

    const destructive = await bridge.call("tools/call", {
      name: "openreel_describe_capability",
      arguments: { capability: "canvas.snapshot.restore" },
    });
    assert.equal(destructive.result.structuredContent.destructive, true);
    assert.equal(destructive.result.structuredContent.executor, "openreel_execute_destructive_capability");
    assert.equal(destructive.result.structuredContent.input_schema.properties.confirm, undefined);
    const wrongExecutor = await bridge.call("tools/call", {
      name: "openreel_execute_capability",
      arguments: {
        project_id: "project-1",
        capability: "canvas.snapshot.restore",
        schema_ref: destructive.result.structuredContent.schema_ref,
        arguments: { nodes: [], edges: [] },
      },
    });
    assert.equal(wrongExecutor.result.isError, true);
    assert.equal(wrongExecutor.result.structuredContent.error_kind, "wrong_capability_executor");

    const historyDescription = await bridge.call("tools/call", {
      name: "openreel_describe_capability",
      arguments: { capability: "node.history.switch" },
    });
    assert.equal(Array.isArray(historyDescription.result.structuredContent.input_schema.oneOf), true);
    const missingHistoryChoice = await bridge.call("tools/call", {
      name: "openreel_execute_capability",
      arguments: {
        project_id: "project-1",
        capability: "node.history.switch",
        schema_ref: historyDescription.result.structuredContent.schema_ref,
        arguments: { node_id: "#1" },
      },
    });
    assert.equal(missingHistoryChoice.result.isError, true);
    assert.equal(missingHistoryChoice.result.structuredContent.error_kind, "capability_arguments_invalid");

    const hiddenCall = await bridge.call("tools/call", {
      name: "openreel_apply_canvas_patch",
      arguments: { project_id: "project-1", operations: [] },
    });
    assert.match(hiddenCall.error.message, /Unknown or private tool/);
  } finally {
    await bridge.close();
    await fake.close();
  }
});

test("complex and uncommon canvas intents discover deferred capabilities without schemas", async () => {
  const fake = await startFakeOpenReel(() => ({ ok: true, ready: true, normalized_fields: {}, errors: [] }));
  const bridge = startBridge(fake.baseUrl);
  try {
    await bridge.call("initialize", { protocolVersion: "2025-03-26", capabilities: {} });
    for (const [query, expected] of [
      ["读取动态模型参数", "node.contract.describe"],
      ["复制节点", "node.duplicate"],
      ["切换历史图片", "node.history.switch"],
      ["批量混合修改画布", "canvas.patch"],
      ["依次运行多个节点", "node.run_many"],
      ["等待节点完成", "node.wait"],
      ["恢复画布快照", "canvas.snapshot.restore"],
      ["批量删除和恢复", "canvas.destructive_batch"],
    ]) {
      const response = await bridge.call("tools/call", {
        name: "openreel_search_capabilities",
        arguments: { query, limit: 10 },
      });
      assert.equal(response.result.structuredContent.matches.some((item) => item.capability === expected), true, query);
      assert.equal(response.result.structuredContent.matches.some((item) => item.input_schema), false, query);
    }
  } finally {
    await bridge.close();
    await fake.close();
  }
});

test("every registered canvas capability is searchable and describable on demand", async () => {
  const fake = await startFakeOpenReel(() => ({ ok: true, ready: true, normalized_fields: {}, errors: [] }));
  const bridge = startBridge(fake.baseUrl);
  const capabilities = [
    "node.contract.describe",
    "node.duplicate",
    "node.history.switch",
    "canvas.patch",
    "node.run_many",
    "node.wait",
    "canvas.snapshot.restore",
    "canvas.destructive_batch",
  ];
  try {
    await bridge.call("initialize", { protocolVersion: "2025-03-26", capabilities: {} });
    for (const capability of capabilities) {
      const search = await bridge.call("tools/call", {
        name: "openreel_search_capabilities",
        arguments: { query: capability, limit: 1 },
      });
      assert.equal(search.result.structuredContent.matches[0].capability, capability);
      const described = await bridge.call("tools/call", {
        name: "openreel_describe_capability",
        arguments: { capability },
      });
      assert.equal(described.result.structuredContent.ok, true);
      assert.equal(typeof described.result.structuredContent.input_schema, "object");
      assert.match(described.result.structuredContent.schema_ref, new RegExp(`${capability.replaceAll(".", "\\.")}:[a-f0-9]{12}$`));
    }
  } finally {
    await bridge.close();
    await fake.close();
  }
});

test("project CRUD including confirmed deletion is directly available", async () => {
  const restCalls = [];
  const fake = await startFakeOpenReel(
    () => ({ ok: true, ready: true, normalized_fields: {}, errors: [] }),
    undefined,
    ({ method, url, body }) => {
      restCalls.push({ method, url, body });
      if (method === "GET" && url === "/api/projects?compact=true") return [{ id: "project-1", title: "Project One" }];
      if (method === "POST" && url === "/api/projects") return { id: "project-1", ...body };
      if (method === "GET" && url === "/api/projects/project-1") return { id: "project-1", title: "Project One" };
      if (method === "PATCH" && url === "/api/projects/project-1") return { id: "project-1", ...body };
      if (method === "DELETE" && url === "/api/projects/project-1") return { ok: true, id: "project-1" };
      return undefined;
    },
  );
  const bridge = startBridge(fake.baseUrl);
  try {
    await bridge.call("initialize", { protocolVersion: "2025-03-26", capabilities: {} });
    const listed = await bridge.call("tools/call", {
      name: "openreel_list_projects",
      arguments: {},
    });
    assert.equal(listed.result.structuredContent.items[0].id, "project-1");
    const created = await bridge.call("tools/call", {
      name: "openreel_create_project",
      arguments: { title: "Project One" },
    });
    assert.equal(created.result.structuredContent.title, "Project One");
    const read = await bridge.call("tools/call", {
      name: "openreel_get_project",
      arguments: { project_id: "project-1" },
    });
    assert.equal(read.result.structuredContent.title, "Project One");
    const updated = await bridge.call("tools/call", {
      name: "openreel_update_project",
      arguments: { project_id: "project-1", title: "Renamed Session" },
    });
    assert.deepEqual(updated.result.structuredContent, { id: "project-1", title: "Renamed Session" });
    assert.deepEqual(
      restCalls.find((item) => item.method === "PATCH")?.body,
      { title: "Renamed Session" },
    );
    const rejectedDelete = await bridge.call("tools/call", {
      name: "openreel_delete_project",
      arguments: { project_id: "project-1", confirm_title: "Wrong" },
    });
    assert.equal(rejectedDelete.result.isError, true);
    const deleted = await bridge.call("tools/call", {
      name: "openreel_delete_project",
      arguments: { project_id: "project-1", confirm_title: "Project One" },
    });
    assert.equal(deleted.result.structuredContent.ok, true);
    assert.equal(restCalls.filter((item) => item.method === "DELETE").length, 1);
  } finally {
    await bridge.close();
    await fake.close();
  }
});

test("project selection switches session scope, rejects cross-project writes, and follows new projects", async () => {
  const projects = [
    { id: "project-1", title: "Project One" },
    { id: "project-2", title: "Project Two" },
    { id: "duplicate-1", title: "Duplicate" },
    { id: "duplicate-2", title: "Duplicate" },
  ];
  const restCalls = [];
  const fake = await startFakeOpenReel(
    () => ({ ok: true, ready: true, normalized_fields: {}, errors: [] }),
    undefined,
    ({ method, url, body }) => {
      restCalls.push({ method, url, body });
      if (method === "GET" && url === "/api/projects?compact=true") return projects;
      if (method === "GET" && url === "/api/projects/project-1") return projects[0];
      if (method === "GET" && url === "/api/projects/project-2") return projects[1];
      if (method === "GET" && url === "/api/projects/project-1/nodes") return { project: "project-1", nodes: [], edges: [] };
      if (method === "GET" && url === "/api/projects/project-2/nodes") return { project: "project-2", nodes: [], edges: [] };
      if (method === "POST" && url === "/api/projects") {
        const created = { id: "project-3", ...body };
        projects.push(created);
        return created;
      }
      return undefined;
    },
  );
  const bridge = startBridge(fake.baseUrl);
  try {
    await bridge.call("initialize", { protocolVersion: "2025-03-26", capabilities: {} });
    const initialList = await bridge.call("tools/call", {
      name: "openreel_list_projects",
      arguments: {},
    });
    assert.equal(initialList.result.structuredContent.items.every((project) => project._codex_selected === false), true);

    const selectedOne = await bridge.call("tools/call", {
      name: "openreel_select_project",
      arguments: { title: "Project One" },
    });
    assert.equal(selectedOne.result.structuredContent.selected_project.id, "project-1");
    assert.equal(selectedOne.result.structuredContent.changed, true);

    const firstCanvas = await bridge.call("tools/call", {
      name: "openreel_get_canvas",
      arguments: {},
    });
    assert.equal(firstCanvas.result.structuredContent.project, "project-1");

    const crossProject = await bridge.call("tools/call", {
      name: "openreel_get_canvas",
      arguments: { project_id: "project-2" },
    });
    assert.equal(crossProject.result.isError, true);
    assert.match(crossProject.result.structuredContent.error, /openreel_select_project/);
    assert.equal(restCalls.some((item) => item.url === "/api/projects/project-2/nodes"), false);

    const duplicateTitle = await bridge.call("tools/call", {
      name: "openreel_select_project",
      arguments: { title: "Duplicate" },
    });
    assert.equal(duplicateTitle.result.isError, true);
    assert.match(duplicateTitle.result.structuredContent.error, /project_id/);

    const selectedTwo = await bridge.call("tools/call", {
      name: "openreel_select_project",
      arguments: { project_id: "project-2" },
    });
    assert.equal(selectedTwo.result.structuredContent.selected_project.id, "project-2");
    const secondCanvas = await bridge.call("tools/call", { name: "openreel_get_canvas", arguments: {} });
    assert.equal(secondCanvas.result.structuredContent.project, "project-2");

    const created = await bridge.call("tools/call", {
      name: "openreel_create_project",
      arguments: { title: "Project Three" },
    });
    assert.equal(created.result.structuredContent.id, "project-3");
    assert.equal(created.result.structuredContent._codex_selected, true);
    const connection = await bridge.call("tools/call", {
      name: "openreel_connection_info",
      arguments: {},
    });
    assert.equal(connection.result.structuredContent.selected_project.id, "project-3");
  } finally {
    await bridge.close();
  }

  const newSession = startBridge(fake.baseUrl);
  try {
    await newSession.call("initialize", { protocolVersion: "2025-03-26", capabilities: {} });
    const connection = await newSession.call("tools/call", {
      name: "openreel_connection_info",
      arguments: {},
    });
    assert.equal(connection.result.structuredContent.selected_project, null);
  } finally {
    await newSession.close();
    await fake.close();
  }
});

function startBridge(baseUrl, extraEnv = {}) {
  const env = { ...process.env };
  for (const name of FORWARDED_ENV_VARS) delete env[name];
  Object.assign(env, { OPENREEL_REMEMBER_CONNECTION: "0" }, extraEnv);
  if (baseUrl !== undefined) env.OPENREEL_BASE_URL = baseUrl;
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

async function describeCapability(bridge, capability) {
  const response = await bridge.call("tools/call", {
    name: "openreel_describe_capability",
    arguments: { capability },
  });
  assert.equal(response.result.structuredContent.ok, true);
  return response.result.structuredContent;
}

async function executeCapability(bridge, capability, args, { destructive = false } = {}) {
  const described = await describeCapability(bridge, capability);
  return bridge.call("tools/call", {
    name: destructive ? "openreel_execute_destructive_capability" : "openreel_execute_capability",
    arguments: {
      project_id: "project-1",
      capability,
      schema_ref: described.schema_ref,
      arguments: args,
      ...(destructive ? { confirm: true } : {}),
    },
  });
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
    const patchResponse = await executeCapability(bridge, "canvas.patch", {
      operations: [
        { op: "move_node", node_id: "#1", x: 120, y: 80 },
        { op: "move_node", node_id: "#2", x: 520, y: 80 },
        { op: "update_edge", edge_id: "edge-1", label: "visual reference" },
        { op: "switch_node_history", node_id: "#2", history_id: "history-1" },
      ],
    });
    assert.equal(patchResponse.result.structuredContent.ok, true);
    const destructiveResponse = await executeCapability(bridge, "canvas.destructive_batch", {
      edge_ids: ["edge-2"],
      restore_snapshot: {
        nodes: [{ id: "restored-1", type: "text", title: "Restored" }],
        edges: [],
      },
    }, { destructive: true });
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
    const response = await executeCapability(bridge, "node.duplicate", {
      node_ids: ["#3"],
      offset_x: 60,
      offset_y: 40,
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
