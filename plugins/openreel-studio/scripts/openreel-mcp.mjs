#!/usr/bin/env node

import { openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

const SERVER_NAME = "OpenReel Studio Direct Bridge";
const SERVER_VERSION = "0.1.0";
const DEFAULT_PORT_SPEC = "7860-7920,8000-8020";
const DEFAULT_REQUEST_TIMEOUT_MS = 20 * 60 * 1000;
const DISCOVERY_TIMEOUT_MS = 1400;
const TERMINAL_NODE_STATUSES = new Set(["completed", "failed", "cancelled", "canceled"]);

const JsonRpcError = {
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
};

let cachedConnection = null;

function objectSchema(properties, required = []) {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

const stringField = (description) => ({ type: "string", description });
const booleanField = (description, defaultValue) => ({
  type: "boolean",
  description,
  ...(defaultValue === undefined ? {} : { default: defaultValue }),
});
const numberField = (description) => ({ type: "number", description });
const objectField = (description) => ({ type: "object", description, additionalProperties: true });
const stringArrayField = (description) => ({
  type: "array",
  description,
  items: { type: "string" },
});
const nodeFieldsSchema = (description) => ({
  type: "object",
  description,
  additionalProperties: true,
  properties: {
    title: stringField("User-visible node title."),
    content: stringField("Text-node body."),
    description: stringField("Optional node description."),
    prompt: stringField("Final model-facing prompt for image, video, or audio nodes."),
    aspect_ratio: stringField("Aspect ratio such as 16:9 or 9:16."),
    resolution: stringField("Image exact pixels such as 2560x1440, or a provider-declared video resolution."),
    quality: stringField("Provider-supported quality value."),
    duration_seconds: { type: "number", exclusiveMinimum: 0, description: "Requested media duration in seconds." },
    model: stringField("Configured OpenReel provider name or model name."),
    provider: stringField("Configured OpenReel provider name."),
    video_mode: stringField("Provider-supported video generation mode."),
    production_path: stringField("Creative production path or method."),
    references: { type: "array", description: "Creative dependencies as refs or {ref, role} objects." },
    depends_on: { type: "array", description: "Explicit upstream dependencies." },
    reference_images: { type: "array", description: "Image references." },
    reference_videos: { type: "array", description: "Video references." },
    reference_audios: { type: "array", description: "Audio references." },
  },
});

const TOOLS = [
  {
    name: "openreel_connection_info",
    title: "Connect to OpenReel Studio",
    description:
      "Find and verify a running OpenReel Studio API. Installed desktop builds are discovered on their dynamic localhost port; remote deployments require OPENREEL_BASE_URL.",
    inputSchema: objectSchema({
      refresh: booleanField("Clear the cached endpoint and discover OpenReel again.", false),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "openreel_list_projects",
    title: "List OpenReel Projects",
    description: "List OpenReel projects without invoking the OpenReel chat agent.",
    inputSchema: objectSchema({
      compact: booleanField("Omit the large project state payload.", true),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "openreel_create_project",
    title: "Create OpenReel Project",
    description: "Create a project that Codex can populate with canvas nodes.",
    inputSchema: objectSchema(
      {
        title: stringField("Project title."),
        description: stringField("Optional project description."),
        genre: stringField("Optional genre."),
        format: stringField("Project format, for example 竖屏短剧 or 横屏视频."),
        episode_count: { type: "integer", minimum: 1, description: "Episode count." },
        duration_per_episode: { type: "integer", minimum: 1, description: "Target seconds per episode." },
        budget_level: stringField("Budget level understood by OpenReel."),
      },
      ["title"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "openreel_get_project",
    title: "Get OpenReel Project",
    description: "Read a project. The large internal state is omitted unless include_state is true.",
    inputSchema: objectSchema(
      {
        project_id: stringField("OpenReel project UUID."),
        include_state: booleanField("Include project state_json for diagnostics.", false),
      },
      ["project_id"],
    ),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "openreel_update_project",
    title: "Update OpenReel Project",
    description: "Update project metadata such as title, description, genre, duration, or status.",
    inputSchema: objectSchema(
      {
        project_id: stringField("OpenReel project UUID."),
        patch: objectField("Fields accepted by the OpenReel project update endpoint."),
      },
      ["project_id", "patch"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "openreel_delete_project",
    title: "Delete OpenReel Project",
    description: "Permanently delete a project. confirm_title must exactly match the current project title.",
    inputSchema: objectSchema(
      {
        project_id: stringField("OpenReel project UUID."),
        confirm_title: stringField("Exact current project title, supplied only after explicit user authorization."),
      },
      ["project_id", "confirm_title"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "openreel_get_canvas",
    title: "Get OpenReel Canvas",
    description: "Read the full persisted canvas graph, including node positions and edges.",
    inputSchema: objectSchema(
      { project_id: stringField("OpenReel project UUID.") },
      ["project_id"],
    ),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "openreel_list_nodes",
    title: "List OpenReel Nodes",
    description: "List the model-visible node index for a project, with optional type, status, surface, or text filters.",
    inputSchema: objectSchema(
      {
        project_id: stringField("OpenReel project UUID."),
        type: { type: "string", enum: ["text", "image", "video", "audio"], description: "Optional node type." },
        status: stringField("Optional node status."),
        surface: stringField("Optional canvas surface."),
        query: stringField("Optional plain-text search."),
        regex: stringField("Optional regular-expression search."),
        case_sensitive: booleanField("Use case-sensitive matching.", false),
        limit: { type: "integer", minimum: 0, description: "Maximum results; 0 requests all nodes." },
      },
      ["project_id"],
    ),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "openreel_get_nodes",
    title: "Get OpenReel Node Details",
    description: "Read one or several detailed nodes by id, or locate detailed nodes by text or regex.",
    inputSchema: objectSchema(
      {
        project_id: stringField("OpenReel project UUID."),
        node_id: stringField("One node id, including a visible id such as #3."),
        node_ids: stringArrayField("Several node ids."),
        query: stringField("Optional plain-text node search."),
        regex: stringField("Optional regular-expression node search."),
        case_sensitive: booleanField("Use case-sensitive matching.", false),
        limit: { type: "integer", minimum: 0, description: "Maximum query matches; 0 requests all." },
      },
      ["project_id"],
    ),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "openreel_describe_node_contract",
    title: "Describe OpenReel Node Contract",
    description:
      "Read the current project/provider contract and preflight candidate fields without creating a node. Returns normalized dynamic defaults, supported values, and field-level errors.",
    inputSchema: objectSchema(
      {
        project_id: stringField("OpenReel project UUID."),
        type: { type: "string", enum: ["text", "image", "video", "audio"], description: "Node type." },
        fields: nodeFieldsSchema("Candidate fields to validate. Image dimensions are never hardcoded when absent."),
      },
      ["project_id", "type"],
    ),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "openreel_create_nodes",
    title: "Create OpenReel Canvas Nodes",
    description:
      "Create one text/image/video/audio node or a batch. Batch items may use client_ref and reference client:<ref> to build dependencies in one call.",
    inputSchema: objectSchema(
      {
        project_id: stringField("OpenReel project UUID."),
        type: { type: "string", enum: ["text", "image", "video", "audio"], description: "Type for a single node." },
        fields: nodeFieldsSchema("Node-first fields for a single node. The bridge preflights these against OpenReel before creation."),
        name: stringField("Optional single-node title alias."),
        prompt: stringField("Optional single-node prompt alias."),
        parent_node_id: stringField("Optional parent node id."),
        nodes: {
          type: "array",
          description: "Batch node definitions accepted by OpenReel node.create.",
          items: {
            type: "object",
            additionalProperties: true,
            properties: {
              client_ref: stringField("Optional batch-local reference name."),
              type: { type: "string", enum: ["text", "image", "video", "audio"] },
              fields: nodeFieldsSchema("Candidate fields preflighted before batch creation."),
              parent_node_id: stringField("Optional parent node id or client:<ref>."),
            },
            required: ["type"],
          },
          minItems: 1,
        },
      },
      ["project_id"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "openreel_update_nodes",
    title: "Update OpenReel Canvas Nodes",
    description: "Patch one or several existing nodes in place while preserving their ids and history.",
    inputSchema: objectSchema(
      {
        project_id: stringField("OpenReel project UUID."),
        node_id: stringField("Single node id."),
        patch: objectField("Patch for one node or for every node_id."),
        node_ids: stringArrayField("Several node ids receiving the same patch."),
        updates: {
          type: "array",
          description: "Batch entries shaped as {node_id, patch}.",
          items: { type: "object", additionalProperties: true },
          minItems: 1,
        },
      },
      ["project_id"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "openreel_move_node",
    title: "Move OpenReel Canvas Node",
    description: "Set a node's canvas coordinates. Visible ids such as #3 are resolved to the persisted node id.",
    inputSchema: objectSchema(
      {
        project_id: stringField("OpenReel project UUID."),
        node_id: stringField("Node id or visible id."),
        x: numberField("Canvas x coordinate."),
        y: numberField("Canvas y coordinate."),
      },
      ["project_id", "node_id", "x", "y"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "openreel_connect_nodes",
    title: "Connect OpenReel Canvas Nodes",
    description:
      "Create a dependency edge between existing nodes. Prefer fields.references when the edge represents a creative dependency.",
    inputSchema: objectSchema(
      {
        project_id: stringField("OpenReel project UUID."),
        source_node_id: stringField("Source node id or visible id."),
        target_node_id: stringField("Target node id or visible id."),
        label: stringField("Optional edge label."),
      },
      ["project_id", "source_node_id", "target_node_id"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "openreel_delete_nodes",
    title: "Delete OpenReel Canvas Nodes",
    description: "Permanently delete selected nodes and their incident edges. Requires confirm=true after explicit user authorization.",
    inputSchema: objectSchema(
      {
        project_id: stringField("OpenReel project UUID."),
        node_ids: stringArrayField("Node ids or visible ids to delete."),
        confirm: booleanField("Must be true after the user explicitly authorizes deletion."),
      },
      ["project_id", "node_ids", "confirm"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "openreel_run_node",
    title: "Run OpenReel Node",
    description:
      "Preflight and run an existing node directly through OpenReel's node runner. This may call the configured media or language model provider, but never the OpenReel chat agent.",
    inputSchema: objectSchema(
      {
        project_id: stringField("OpenReel project UUID."),
        node_id: stringField("Node id or visible id."),
        action: { type: "string", enum: ["run", "render", "force"], description: "Optional node.run action." },
        extra_fields: objectField("Temporary run fields that are not automatically written to the node."),
        hidden_extra_field_keys: stringArrayField("Temporary keys to remove from persisted output and response."),
        wait: booleanField("Poll the persisted node until it completes or fails.", true),
        wait_timeout_seconds: { type: "integer", minimum: 1, maximum: 1200, description: "Polling timeout." },
      },
      ["project_id", "node_id"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "openreel_wait_for_node",
    title: "Wait for OpenReel Node",
    description: "Poll a persisted node until its status is completed, failed, or cancelled.",
    inputSchema: objectSchema(
      {
        project_id: stringField("OpenReel project UUID."),
        node_id: stringField("Node id or visible id."),
        timeout_seconds: { type: "integer", minimum: 1, maximum: 1200, description: "Polling timeout." },
        poll_interval_seconds: { type: "number", minimum: 0.5, maximum: 10, description: "Polling interval." },
      },
      ["project_id", "node_id"],
    ),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "openreel_upload_node_media",
    title: "Upload Media to OpenReel Node",
    description: "Upload a local image or video file as the completed output of an existing matching node.",
    inputSchema: objectSchema(
      {
        project_id: stringField("OpenReel project UUID."),
        node_id: stringField("Existing image or video node id."),
        file_path: stringField("Absolute local path readable by the Codex host."),
      },
      ["project_id", "node_id", "file_path"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "openreel_get_model_config",
    title: "Get Masked OpenReel Model Configuration",
    description: "Read OpenReel's parsed model/provider configuration with secrets masked. Raw config text is never returned.",
    inputSchema: objectSchema({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "openreel_list_media_protocols",
    title: "List OpenReel Media Protocols",
    description: "List the installed OpenReel protocol catalog for image, video, or audio providers.",
    inputSchema: objectSchema(
      {
        kind: { type: "string", enum: ["image", "video", "audio"], description: "Media protocol kind." },
      },
      ["kind"],
    ),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "openreel_search_skills",
    title: "Search OpenReel Production Skills",
    description:
      "Search OpenReel's workflow, prompt, or review skills so Codex can follow the product's current production guidance before authoring nodes.",
    inputSchema: objectSchema(
      {
        query: stringField("Search text."),
        queries: stringArrayField("Optional batch of search texts."),
        category: { type: "string", enum: ["workflow", "prompt", "review"], description: "Required skill category." },
        scope: { type: "string", enum: ["user", "builtin"], description: "Optional source scope." },
        regex: stringField("Optional regular-expression search."),
        case_sensitive: booleanField("Use case-sensitive matching.", false),
      },
      ["category"],
    ),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "openreel_get_skill",
    title: "Read OpenReel Production Skill",
    description: "Read an OpenReel skill summary or full content without invoking an OpenReel agent.",
    inputSchema: objectSchema(
      {
        name: stringField("Exact skill name returned by openreel_search_skills."),
        category: { type: "string", enum: ["workflow", "prompt", "review"], description: "Optional category constraint." },
        scope: { type: "string", enum: ["user", "builtin"], description: "Optional source scope." },
        detail: { type: "string", enum: ["summary", "full"], description: "Read summary or full content." },
      },
      ["name"],
    ),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
];

function requireString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function boundedNumber(value, fallback, min, max) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function encodeSegment(value, name) {
  return encodeURIComponent(requireString(value, name));
}

function normalizeBaseUrl(raw) {
  const parsed = new URL(requireString(raw, "OPENREEL_BASE_URL"));
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw new Error("OPENREEL_BASE_URL must use http:// or https://.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Do not embed credentials in OPENREEL_BASE_URL; use OPENREEL_USERNAME and OPENREEL_PASSWORD.");
  }
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function authHeaders() {
  const token = String(process.env.OPENREEL_TOKEN ?? "").trim();
  if (token) return { Authorization: `Bearer ${token}` };
  const username = String(process.env.OPENREEL_USERNAME ?? "").trim();
  const password = String(process.env.OPENREEL_PASSWORD ?? "");
  if (username || password) {
    if (!username || !password) {
      throw new Error("OPENREEL_USERNAME and OPENREEL_PASSWORD must be provided together.");
    }
    return { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` };
  }
  return {};
}

function authMode() {
  if (String(process.env.OPENREEL_TOKEN ?? "").trim()) return "bearer";
  if (String(process.env.OPENREEL_USERNAME ?? "").trim()) return "basic";
  return "none";
}

function parsePortSpec(raw) {
  const ports = [];
  for (const part of String(raw || DEFAULT_PORT_SPEC).split(",")) {
    const token = part.trim();
    if (!token) continue;
    const range = token.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start < 1 || end > 65535 || end < start || end - start > 300) {
        throw new Error(`Invalid OPENREEL_DISCOVERY_PORTS range: ${token}`);
      }
      for (let port = start; port <= end; port += 1) ports.push(port);
      continue;
    }
    const port = Number(token);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid OPENREEL_DISCOVERY_PORTS port: ${token}`);
    }
    ports.push(port);
  }
  return [...new Set(ports)].slice(0, 400);
}

function apiUrl(baseUrl, apiPath) {
  const suffix = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
  return `${baseUrl}${suffix}`;
}

async function parseResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorPreview(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return String(text ?? "").replace(/\s+/g, " ").slice(0, 1200);
}

async function probeOpenReel(baseUrl) {
  try {
    const response = await fetch(apiUrl(baseUrl, "/api/health"), {
      headers: { Accept: "application/json", ...authHeaders() },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const health = await parseResponse(response);
    if (health?.status !== "ok" || health?.app !== "openreel-studio") return null;
    return health;
  } catch {
    return null;
  }
}

async function discoverConnection({ refresh = false } = {}) {
  if (refresh) cachedConnection = null;
  if (cachedConnection) return cachedConnection;

  const explicit = String(process.env.OPENREEL_BASE_URL ?? "").trim();
  if (explicit) {
    const baseUrl = normalizeBaseUrl(explicit);
    const health = await probeOpenReel(baseUrl);
    if (!health) {
      throw new Error(
        `OPENREEL_BASE_URL did not return a verified OpenReel health response: ${baseUrl}. ` +
          "Check that OpenReel is running and that OPENREEL_USERNAME/OPENREEL_PASSWORD or OPENREEL_TOKEN is correct.",
      );
    }
    cachedConnection = { baseUrl, health, source: "explicit" };
    return cachedConnection;
  }

  const ports = parsePortSpec(process.env.OPENREEL_DISCOVERY_PORTS);
  const candidates = ports.map((port) => `http://127.0.0.1:${port}`);
  for (let offset = 0; offset < candidates.length; offset += 24) {
    const batch = candidates.slice(offset, offset + 24);
    const results = await Promise.all(batch.map(async (baseUrl) => ({ baseUrl, health: await probeOpenReel(baseUrl) })));
    const match = results.find((item) => item.health);
    if (match) {
      cachedConnection = { ...match, source: "localhost-discovery" };
      return cachedConnection;
    }
  }

  throw new Error(
    "No running OpenReel Studio installation was found. Start the installed OpenReel desktop app, " +
      `or start the source API. Scanned localhost ports ${process.env.OPENREEL_DISCOVERY_PORTS || DEFAULT_PORT_SPEC}. ` +
      "For Docker or a remote deployment, set OPENREEL_BASE_URL explicitly before starting Codex.",
  );
}

async function requestOpenReel(apiPath, options = {}) {
  const connection = await discoverConnection();
  const timeoutMs = boundedNumber(
    options.timeoutMs,
    boundedNumber(process.env.OPENREEL_REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS, 1000, 30 * 60 * 1000),
    1000,
    30 * 60 * 1000,
  );
  const headers = { Accept: "application/json", ...authHeaders(), ...(options.headers ?? {}) };
  let body = options.body;
  if (options.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.json);
  }
  const response = await fetch(apiUrl(connection.baseUrl, apiPath), {
    method: options.method ?? "GET",
    headers,
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await parseResponse(response);
  if (!response.ok) {
    throw new Error(`OpenReel ${options.method ?? "GET"} ${apiPath} failed (${response.status}): ${errorPreview(payload)}`);
  }
  return payload;
}

async function callOpenReelTool(tool, args) {
  const response = await requestOpenReel("/api/tools/call", {
    method: "POST",
    json: { tool, args },
  });
  return response?.result ?? response;
}

async function requestNodeContract(projectId, type, fields = {}) {
  return requestOpenReel("/api/tools/node-contract", {
    method: "POST",
    json: {
      project_id: requireString(projectId, "project_id"),
      type: requireString(type, "type"),
      fields: fields && typeof fields === "object" && !Array.isArray(fields) ? fields : {},
    },
  });
}

function contractFailure(contract, index) {
  return {
    ok: false,
    error_kind: "node_contract_failed",
    error: "OpenReel rejected the node fields before creation.",
    ...(index === undefined ? {} : { batch_index: index }),
    contract,
    hint: "Repair the reported fields and retry creation. Do not bypass preflight or create a duplicate replacement node.",
  };
}

async function preflightCreateArgs(args) {
  const projectId = requireString(args.project_id, "project_id");
  if (Array.isArray(args.nodes)) {
    const normalizedNodes = [];
    const contracts = [];
    for (let index = 0; index < args.nodes.length; index += 1) {
      const item = args.nodes[index];
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return contractFailure({ ok: false, ready: false, error: "Batch item must be an object." }, index);
      }
      const fields = item.fields && typeof item.fields === "object" && !Array.isArray(item.fields)
        ? { ...item.fields }
        : {};
      const contract = await requestNodeContract(projectId, item.type, fields);
      contracts.push(contract);
      if (contract?.ok !== true || contract?.ready !== true) return contractFailure(contract, index);
      normalizedNodes.push({ ...item, fields: contract.normalized_fields ?? fields });
    }
    return { ok: true, args: { ...args, nodes: normalizedNodes }, contracts };
  }
  const fields = args.fields && typeof args.fields === "object" && !Array.isArray(args.fields)
    ? { ...args.fields }
    : {};
  if (!fields.prompt && typeof args.prompt === "string" && args.prompt.trim()) fields.prompt = args.prompt.trim();
  const contract = await requestNodeContract(projectId, args.type, fields);
  if (contract?.ok !== true || contract?.ready !== true) return contractFailure(contract);
  return { ok: true, args: { ...args, fields: contract.normalized_fields ?? fields }, contracts: [contract] };
}

function nodeInputFields(node) {
  for (const key of ["input", "input_json", "input_data", "fields"]) {
    const value = node?.[key];
    if (value && typeof value === "object" && !Array.isArray(value)) return { ...value };
  }
  return {};
}

async function preflightExistingNode(args) {
  const projectId = requireString(args.project_id, "project_id");
  const node = await callOpenReelTool("node.get", {
    project_id: projectId,
    node_id: requireString(args.node_id, "node_id"),
  });
  if (!node || node.ok === false || node.error) {
    return contractFailure({
      ok: false,
      ready: false,
      error: node?.error || "OpenReel node could not be read before execution.",
      error_kind: node?.error_kind || "node_not_found",
    });
  }
  const fields = {
    ...nodeInputFields(node),
    ...(args.extra_fields && typeof args.extra_fields === "object" && !Array.isArray(args.extra_fields)
      ? args.extra_fields
      : {}),
  };
  const contract = await requestNodeContract(projectId, node.type, fields);
  if (contract?.ok !== true || contract?.ready !== true) {
    const failure = contractFailure(contract);
    failure.error_kind = "node_run_preflight_failed";
    failure.node_id = args.node_id;
    failure.hint = "Update the existing node with the reported field repairs, then rerun that same node.";
    return failure;
  }
  return { ok: true, contract };
}

async function resolveInternalNodeId(projectId, nodeId) {
  const requested = requireString(nodeId, "node_id");
  const result = await callOpenReelTool("node.get", {
    project_id: requireString(projectId, "project_id"),
    node_id: requested,
  });
  if (result?.ok === false) {
    throw new Error(`Cannot resolve OpenReel node ${requested}: ${result.error || "node.get failed"}`);
  }
  return String(result?._canvas_node_id || result?._canvas_id || result?.canvas_node_id || result?.id || requested);
}

async function waitForNode({ project_id, node_id, timeout_seconds = 600, poll_interval_seconds = 2 }) {
  const projectId = requireString(project_id, "project_id");
  const internalId = await resolveInternalNodeId(projectId, node_id);
  const timeoutMs = boundedNumber(timeout_seconds, 600, 1, 1200) * 1000;
  const intervalMs = boundedNumber(poll_interval_seconds, 2, 0.5, 10) * 1000;
  const startedAt = Date.now();
  let node = null;
  while (Date.now() - startedAt <= timeoutMs) {
    node = await requestOpenReel(`/api/projects/${encodeSegment(projectId, "project_id")}/nodes/${encodeSegment(internalId, "node_id")}`);
    const status = String(node?.status ?? "").toLowerCase();
    if (TERMINAL_NODE_STATUSES.has(status)) {
      return {
        ok: status === "completed",
        terminal: true,
        status,
        elapsed_seconds: Math.round((Date.now() - startedAt) / 100) / 10,
        node,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return {
    ok: false,
    terminal: false,
    status: String(node?.status ?? "unknown"),
    error: "Timed out while waiting for the OpenReel node.",
    elapsed_seconds: Math.round((Date.now() - startedAt) / 100) / 10,
    node,
  };
}

function omitUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function safeProject(project, includeState) {
  if (!project || typeof project !== "object" || includeState) return project;
  const result = { ...project };
  delete result.state_json;
  return result;
}

function mimeTypeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return (
    {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".gif": "image/gif",
      ".bmp": "image/bmp",
      ".mp4": "video/mp4",
      ".webm": "video/webm",
      ".mov": "video/quicktime",
      ".m4v": "video/x-m4v",
    }[extension] ?? "application/octet-stream"
  );
}

const HANDLERS = {
  async openreel_connection_info(args) {
    const connection = await discoverConnection({ refresh: args.refresh === true });
    const parsed = new URL(connection.baseUrl);
    return {
      ok: true,
      api_base: connection.baseUrl,
      source: connection.source,
      installation_mode: ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)
        ? "local-installed-or-source"
        : "remote-or-docker",
      authentication: authMode(),
      health: connection.health,
      direct_control: true,
      openreel_chat_agent_used: false,
    };
  },

  async openreel_list_projects(args) {
    const compact = args.compact !== false;
    return requestOpenReel(`/api/projects?compact=${compact ? "true" : "false"}`);
  },

  async openreel_create_project(args) {
    const body = omitUndefined({
      title: requireString(args.title, "title"),
      description: args.description,
      genre: args.genre,
      format: args.format,
      episode_count: args.episode_count,
      duration_per_episode: args.duration_per_episode,
      budget_level: args.budget_level,
    });
    return requestOpenReel("/api/projects", { method: "POST", json: body });
  },

  async openreel_get_project(args) {
    const projectId = encodeSegment(args.project_id, "project_id");
    const project = await requestOpenReel(`/api/projects/${projectId}`);
    return safeProject(project, args.include_state === true);
  },

  async openreel_update_project(args) {
    const projectId = encodeSegment(args.project_id, "project_id");
    if (!args.patch || typeof args.patch !== "object" || Array.isArray(args.patch)) {
      throw new Error("patch must be an object.");
    }
    return requestOpenReel(`/api/projects/${projectId}`, { method: "PATCH", json: args.patch });
  },

  async openreel_delete_project(args) {
    const projectIdRaw = requireString(args.project_id, "project_id");
    const projectId = encodeSegment(projectIdRaw, "project_id");
    const project = await requestOpenReel(`/api/projects/${projectId}`);
    if (requireString(args.confirm_title, "confirm_title") !== String(project?.title ?? "")) {
      throw new Error("confirm_title does not exactly match the current OpenReel project title.");
    }
    return requestOpenReel(`/api/projects/${projectId}`, { method: "DELETE" });
  },

  async openreel_get_canvas(args) {
    const projectId = encodeSegment(args.project_id, "project_id");
    return requestOpenReel(`/api/projects/${projectId}/nodes`);
  },

  async openreel_list_nodes(args) {
    return callOpenReelTool("node.list", omitUndefined({
      project_id: args.project_id,
      type: args.type,
      status: args.status,
      surface: args.surface,
      query: args.query,
      regex: args.regex,
      case_sensitive: args.case_sensitive,
      limit: args.limit,
    }));
  },

  async openreel_get_nodes(args) {
    return callOpenReelTool("node.get", omitUndefined({
      project_id: args.project_id,
      node_id: args.node_id,
      node_ids: args.node_ids,
      query: args.query,
      regex: args.regex,
      case_sensitive: args.case_sensitive,
      limit: args.limit,
    }));
  },

  async openreel_describe_node_contract(args) {
    return requestNodeContract(args.project_id, args.type, args.fields ?? {});
  },

  async openreel_create_nodes(args) {
    const preflight = await preflightCreateArgs(args);
    if (preflight.ok !== true) return preflight;
    const normalized = preflight.args;
    return callOpenReelTool("node.create", omitUndefined({
      project_id: normalized.project_id,
      type: normalized.type,
      fields: normalized.fields,
      name: normalized.name,
      prompt: normalized.prompt,
      parent_node_id: normalized.parent_node_id,
      nodes: normalized.nodes,
    }));
  },

  async openreel_update_nodes(args) {
    return callOpenReelTool("node.update", omitUndefined({
      project_id: args.project_id,
      node_id: args.node_id,
      patch: args.patch,
      updates: args.updates,
      node_ids: args.node_ids,
    }));
  },

  async openreel_move_node(args) {
    const projectId = requireString(args.project_id, "project_id");
    const internalId = await resolveInternalNodeId(projectId, args.node_id);
    return requestOpenReel(
      `/api/projects/${encodeSegment(projectId, "project_id")}/nodes/${encodeSegment(internalId, "node_id")}/position`,
      { method: "PATCH", json: { x: Number(args.x), y: Number(args.y) } },
    );
  },

  async openreel_connect_nodes(args) {
    const projectId = requireString(args.project_id, "project_id");
    const [sourceId, targetId] = await Promise.all([
      resolveInternalNodeId(projectId, args.source_node_id),
      resolveInternalNodeId(projectId, args.target_node_id),
    ]);
    return requestOpenReel(`/api/projects/${encodeSegment(projectId, "project_id")}/edges`, {
      method: "POST",
      json: omitUndefined({ source_node_id: sourceId, target_node_id: targetId, label: args.label }),
    });
  },

  async openreel_delete_nodes(args) {
    if (args.confirm !== true) throw new Error("confirm must be true after explicit user authorization.");
    if (!Array.isArray(args.node_ids) || args.node_ids.length === 0) throw new Error("node_ids must be a non-empty array.");
    const projectId = requireString(args.project_id, "project_id");
    const nodeIds = await Promise.all(args.node_ids.map((nodeId) => resolveInternalNodeId(projectId, nodeId)));
    return requestOpenReel(`/api/projects/${encodeSegment(projectId, "project_id")}/nodes/delete`, {
      method: "POST",
      json: { node_ids: nodeIds },
    });
  },

  async openreel_run_node(args) {
    const preflight = await preflightExistingNode(args);
    if (preflight.ok !== true) return preflight;
    const result = await callOpenReelTool("node.run", omitUndefined({
      project_id: args.project_id,
      node_id: args.node_id,
      action: args.action,
      extra_fields: args.extra_fields,
      hidden_extra_field_keys: args.hidden_extra_field_keys,
    }));
    if (args.wait === false || result?.ok === false) return result;
    const nodeId = result?._canvas_node_id || result?._canvas_id || args.node_id;
    const waited = await waitForNode({
      project_id: args.project_id,
      node_id: nodeId,
      timeout_seconds: args.wait_timeout_seconds ?? 600,
      poll_interval_seconds: 2,
    });
    return { ok: waited.ok, run_result: result, wait_result: waited };
  },

  async openreel_wait_for_node(args) {
    return waitForNode(args);
  },

  async openreel_upload_node_media(args) {
    const filePath = path.resolve(requireString(args.file_path, "file_path"));
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error("file_path must point to a regular file.");
    const projectId = requireString(args.project_id, "project_id");
    const internalId = await resolveInternalNodeId(projectId, args.node_id);
    const blob = await openAsBlob(filePath, { type: mimeTypeFor(filePath) });
    const form = new FormData();
    form.append("file", blob, path.basename(filePath));
    return requestOpenReel(
      `/api/projects/${encodeSegment(projectId, "project_id")}/nodes/${encodeSegment(internalId, "node_id")}/media`,
      { method: "POST", body: form },
    );
  },

  async openreel_get_model_config() {
    const response = await requestOpenReel("/api/tools/config/file?mask_secrets=true");
    return {
      ok: response?.valid !== false,
      valid: response?.valid,
      errors: response?.errors ?? [],
      config: response?.parsed ?? {},
      secrets_masked: true,
      raw_text_returned: false,
    };
  },

  async openreel_list_media_protocols(args) {
    const kind = requireString(args.kind, "kind");
    if (!new Set(["image", "video", "audio"]).has(kind)) throw new Error("kind must be image, video, or audio.");
    return requestOpenReel(`/api/tools/config/${kind}-protocols`);
  },

  async openreel_search_skills(args) {
    return callOpenReelTool("skill.search", omitUndefined({
      query: args.query,
      queries: args.queries,
      category: args.category,
      scope: args.scope,
      regex: args.regex,
      case_sensitive: args.case_sensitive,
    }));
  },

  async openreel_get_skill(args) {
    return callOpenReelTool("skill.get", omitUndefined({
      name: args.name,
      category: args.category,
      scope: args.scope,
      detail: args.detail === "summary" ? "" : args.detail,
    }));
  },
};

function asStructuredContent(data) {
  if (data && typeof data === "object" && !Array.isArray(data)) return data;
  if (Array.isArray(data)) return { items: data, total: data.length };
  return { value: data };
}

function toolResult(data, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: asStructuredContent(data),
    ...(isError ? { isError: true } : {}),
  };
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleRequest(message) {
  const { id, method, params } = message;

  if (method === "initialize") {
    sendResult(id, {
      protocolVersion: params?.protocolVersion ?? "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions:
        "Codex is the OpenReel orchestrator. Use these atomic project/canvas/node tools directly. Never call or delegate to OpenReel /api/chat or its agent loop. Read current ids and state before writes, use references for creative dependencies, and require explicit user authorization for destructive tools.",
    });
    return;
  }

  if (method === "ping") {
    sendResult(id, {});
    return;
  }

  if (method === "tools/list") {
    sendResult(id, { tools: TOOLS });
    return;
  }

  if (method === "tools/call") {
    const name = String(params?.name ?? "");
    const handler = HANDLERS[name];
    if (!handler) {
      sendError(id, JsonRpcError.INVALID_PARAMS, `Unknown tool: ${name}`);
      return;
    }
    try {
      const data = await handler(params?.arguments ?? {});
      sendResult(id, toolResult(data, data?.ok === false));
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      sendResult(id, toolResult({ ok: false, error: messageText }, true));
    }
    return;
  }

  if (id !== undefined) sendError(id, JsonRpcError.METHOD_NOT_FOUND, `Method not found: ${method}`);
}

if (process.argv.includes("--check")) {
  try {
    const connection = await discoverConnection({ refresh: true });
    process.stdout.write(`${JSON.stringify({ ok: true, ...connection }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
} else {
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    try {
      const message = JSON.parse(line);
      void handleRequest(message).catch((error) => {
        if (message?.id !== undefined) {
          sendError(message.id, JsonRpcError.INTERNAL_ERROR, error instanceof Error ? error.message : String(error));
        }
      });
    } catch {
      // stdout is reserved for MCP messages; malformed notifications are ignored.
    }
  });
}
