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
const positionSchema = (description) => ({
  type: "object",
  description,
  additionalProperties: false,
  properties: {
    x: numberField("Canvas x coordinate."),
    y: numberField("Canvas y coordinate."),
  },
  required: ["x", "y"],
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
        position: positionSchema("Optional persisted position for the created node."),
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
              position: positionSchema("Optional persisted position for this node."),
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
    name: "openreel_duplicate_nodes",
    title: "Duplicate OpenReel Canvas Nodes",
    description: "Duplicate one or several nodes as new idle nodes, preserving creative fields but not generated output history.",
    inputSchema: objectSchema(
      {
        project_id: stringField("OpenReel project UUID."),
        node_ids: stringArrayField("Node ids or visible ids to duplicate."),
        title_suffix: stringField("Suffix appended to each duplicated node title."),
        offset_x: numberField("Horizontal offset from each source node."),
        offset_y: numberField("Vertical offset from each source node."),
      },
      ["project_id", "node_ids"],
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
    name: "openreel_move_nodes",
    title: "Move OpenReel Canvas Nodes",
    description: "Set persisted canvas coordinates for one node or a batch. Visible ids such as #3 are resolved first.",
    inputSchema: objectSchema(
      {
        project_id: stringField("OpenReel project UUID."),
        node_id: stringField("Single node id or visible id."),
        x: numberField("Single-node canvas x coordinate."),
        y: numberField("Single-node canvas y coordinate."),
        moves: {
          type: "array",
          description: "Batch entries shaped as {node_id, x, y}.",
          items: objectSchema(
            {
              node_id: stringField("Node id or visible id."),
              x: numberField("Canvas x coordinate."),
              y: numberField("Canvas y coordinate."),
            },
            ["node_id", "x", "y"],
          ),
          minItems: 1,
        },
      },
      ["project_id"],
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
    name: "openreel_update_edges",
    title: "Update OpenReel Canvas Edges",
    description: "Update the label of one dependency edge or a batch of edges without recreating them.",
    inputSchema: objectSchema(
      {
        project_id: stringField("OpenReel project UUID."),
        edge_id: stringField("Single persisted edge id."),
        label: stringField("New edge label; an empty value clears it."),
        updates: {
          type: "array",
          description: "Batch entries shaped as {edge_id, label}.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              edge_id: stringField("Persisted edge id."),
              label: stringField("New label; omit or pass an empty string to clear it."),
            },
            required: ["edge_id"],
          },
          minItems: 1,
        },
      },
      ["project_id"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "openreel_delete_edges",
    title: "Delete OpenReel Canvas Edges",
    description: "Delete dependency edges by id or source/target pair after explicit user authorization.",
    inputSchema: objectSchema(
      {
        project_id: stringField("OpenReel project UUID."),
        edge_ids: stringArrayField("Persisted edge ids to delete."),
        edges: {
          type: "array",
          description: "Edges addressed by {source_node_id, target_node_id}.",
          items: objectSchema(
            {
              source_node_id: stringField("Source node id or visible id."),
              target_node_id: stringField("Target node id or visible id."),
            },
            ["source_node_id", "target_node_id"],
          ),
          minItems: 1,
        },
        confirm: booleanField("Must be true after the user explicitly authorizes deletion."),
      },
      ["project_id", "confirm"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
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
    name: "openreel_switch_node_history",
    title: "Switch OpenReel Node Media History",
    description: "Switch an image, video, or audio node to a persisted media-history version.",
    inputSchema: objectSchema(
      {
        project_id: stringField("OpenReel project UUID."),
        node_id: stringField("Node id or visible id."),
        history_id: stringField("History item id."),
        index: { type: "integer", minimum: 0, description: "History index when history_id is not used." },
      },
      ["project_id", "node_id"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "openreel_restore_canvas_snapshot",
    title: "Restore OpenReel Canvas Snapshot",
    description: "Restore persisted node and edge snapshots after explicit user authorization; existing matching ids are updated.",
    inputSchema: objectSchema(
      {
        project_id: stringField("OpenReel project UUID."),
        nodes: {
          type: "array",
          description: "Canvas node snapshots accepted by OpenReel.",
          items: { type: "object", additionalProperties: true },
        },
        edges: {
          type: "array",
          description: "Canvas edge snapshots accepted by OpenReel.",
          items: { type: "object", additionalProperties: true },
        },
        confirm: booleanField("Must be true after the user explicitly authorizes snapshot restoration."),
      },
      ["project_id", "nodes", "edges", "confirm"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
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
    name: "openreel_apply_canvas_patch",
    title: "Apply OpenReel Canvas Patch",
    description:
      "Apply an ordered, typed set of non-destructive canvas mutations. Supported operations create, duplicate, update, or move nodes; connect nodes; update edge labels; and switch node media history.",
    inputSchema: objectSchema(
      {
        project_id: stringField("OpenReel project UUID."),
        operations: {
          type: "array",
          description: "Ordered canvas operations. Later operations may reference an earlier create with client:<client_ref>.",
          minItems: 1,
          items: {
            oneOf: [
              objectSchema({
                op: { const: "create_node" },
                client_ref: stringField("Optional patch-local id for later client:<ref> references."),
                type: { type: "string", enum: ["text", "image", "video", "audio"] },
                fields: nodeFieldsSchema("Node fields preflighted against the dynamic contract."),
                name: stringField("Optional title alias."),
                prompt: stringField("Optional prompt alias."),
                parent_node_id: stringField("Optional parent node id or client:<ref>."),
                position: positionSchema("Optional persisted position."),
              }, ["op", "type"]),
              objectSchema({
                op: { const: "duplicate_node" },
                node_id: stringField("Source node id or visible id."),
                title_suffix: stringField("Suffix appended to the duplicated title."),
                offset_x: numberField("Horizontal offset."),
                offset_y: numberField("Vertical offset."),
              }, ["op", "node_id"]),
              objectSchema({
                op: { const: "update_node" },
                node_id: stringField("Node id, visible id, or client:<ref>."),
                patch: objectField("Node fields or persisted node patch."),
              }, ["op", "node_id", "patch"]),
              objectSchema({
                op: { const: "move_node" },
                node_id: stringField("Node id, visible id, or client:<ref>."),
                x: numberField("Canvas x coordinate."),
                y: numberField("Canvas y coordinate."),
              }, ["op", "node_id", "x", "y"]),
              objectSchema({
                op: { const: "connect_nodes" },
                source_node_id: stringField("Source node id, visible id, or client:<ref>."),
                target_node_id: stringField("Target node id, visible id, or client:<ref>."),
                label: stringField("Optional edge label."),
              }, ["op", "source_node_id", "target_node_id"]),
              objectSchema({
                op: { const: "update_edge" },
                edge_id: stringField("Persisted edge id."),
                label: stringField("New label; omit or pass an empty string to clear it."),
              }, ["op", "edge_id"]),
              objectSchema({
                op: { const: "switch_node_history" },
                node_id: stringField("Image, video, or audio node id."),
                history_id: stringField("History item id."),
                index: { type: "integer", minimum: 0, description: "History index when history_id is omitted." },
              }, ["op", "node_id"]),
            ],
          },
        },
      },
      ["project_id", "operations"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "openreel_delete_canvas_items",
    title: "Delete or Restore OpenReel Canvas Items",
    description:
      "Delete selected nodes or edges, or restore a known canvas snapshot. Requires confirm=true after explicit user authorization.",
    inputSchema: objectSchema(
      {
        project_id: stringField("OpenReel project UUID."),
        node_ids: stringArrayField("Node ids or visible ids to delete."),
        edge_ids: stringArrayField("Persisted edge ids to delete."),
        edges: {
          type: "array",
          description: "Edges to delete by source/target pair.",
          items: objectSchema({
            source_node_id: stringField("Source node id or visible id."),
            target_node_id: stringField("Target node id or visible id."),
          }, ["source_node_id", "target_node_id"]),
        },
        restore_snapshot: {
          type: "object",
          description: "Optional known snapshot shaped as {nodes, edges} to restore.",
          additionalProperties: false,
          properties: {
            nodes: { type: "array", items: { type: "object", additionalProperties: true } },
            edges: { type: "array", items: { type: "object", additionalProperties: true } },
          },
          required: ["nodes", "edges"],
        },
        confirm: booleanField("Must be true after explicit user authorization."),
      },
      ["project_id", "confirm"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "openreel_run_nodes",
    title: "Run OpenReel Canvas Nodes",
    description: "Preflight and run one or several persisted nodes in order, optionally waiting for each terminal state.",
    inputSchema: objectSchema(
      {
        project_id: stringField("OpenReel project UUID."),
        runs: {
          type: "array",
          minItems: 1,
          items: objectSchema({
            node_id: stringField("Node id or visible id."),
            action: { type: "string", enum: ["run", "render", "force"] },
            extra_fields: objectField("Temporary run fields."),
            hidden_extra_field_keys: stringArrayField("Temporary keys excluded from persisted output."),
            wait: booleanField("Wait for the persisted terminal state.", true),
            wait_timeout_seconds: { type: "integer", minimum: 1, maximum: 1200 },
          }, ["node_id"]),
        },
      },
      ["project_id", "runs"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
];

const EXPOSED_TOOL_NAMES = new Set([
  "openreel_connection_info",
  "openreel_list_projects",
  "openreel_get_canvas",
  "openreel_describe_node_contract",
  "openreel_apply_canvas_patch",
  "openreel_delete_canvas_items",
  "openreel_run_nodes",
  "openreel_upload_node_media",
]);

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

function nodePosition(node) {
  const nested = node?.position && typeof node.position === "object" ? node.position : {};
  const x = Number(nested.x ?? node?.position_x);
  const y = Number(nested.y ?? node?.position_y);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

async function setNodePosition(projectId, nodeId, position) {
  const internalId = await resolveInternalNodeId(projectId, nodeId);
  const x = Number(position?.x);
  const y = Number(position?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Canvas position requires finite x and y values.");
  return requestOpenReel(
    `/api/projects/${encodeSegment(projectId, "project_id")}/nodes/${encodeSegment(internalId, "node_id")}/position`,
    { method: "PATCH", json: { x, y } },
  );
}

async function applyCreatedPositions(projectId, result, args) {
  const placements = [];
  if (Array.isArray(args.nodes)) {
    for (const created of Array.isArray(result?.nodes) ? result.nodes : []) {
      const source = args.nodes[Number(created?.index)];
      if (!source?.position) continue;
      const nodeId = created?._canvas_id || created?._canvas_node_id || created?.id;
      if (!nodeId) continue;
      placements.push(await setNodePosition(projectId, nodeId, source.position));
    }
  } else if (args.position) {
    const nodeId = result?._canvas_id || result?._canvas_node_id || result?.id;
    if (nodeId) placements.push(await setNodePosition(projectId, nodeId, args.position));
  }
  return placements.length ? { ...result, placements } : result;
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

function resolvePatchRefs(value, refs) {
  if (typeof value === "string" && value.startsWith("client:")) {
    const resolved = refs.get(value.slice("client:".length));
    if (!resolved) throw new Error(`Unknown patch-local reference: ${value}`);
    return resolved;
  }
  if (Array.isArray(value)) return value.map((item) => resolvePatchRefs(item, refs));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolvePatchRefs(item, refs)]));
  }
  return value;
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

  async openreel_apply_canvas_patch(args) {
    const projectId = requireString(args.project_id, "project_id");
    if (!Array.isArray(args.operations) || args.operations.length === 0) {
      throw new Error("operations must be a non-empty array.");
    }
    const refs = new Map();
    const results = [];
    for (let index = 0; index < args.operations.length; index += 1) {
      try {
        const operation = resolvePatchRefs(args.operations[index], refs);
        const op = requireString(operation?.op, `operations[${index}].op`);
        let result;
        if (op === "create_node") {
          const createArgs = {
            project_id: projectId,
            type: operation.type,
            fields: operation.fields ?? {},
            name: operation.name,
            prompt: operation.prompt,
            parent_node_id: operation.parent_node_id,
            position: operation.position,
          };
          const preflight = await preflightCreateArgs(createArgs);
          if (preflight.ok !== true) result = preflight;
          else {
            const normalized = preflight.args;
            const created = await callOpenReelTool("node.create", omitUndefined({
              project_id: projectId,
              type: normalized.type,
              fields: normalized.fields,
              name: normalized.name,
              prompt: normalized.prompt,
              parent_node_id: normalized.parent_node_id,
            }));
            result = created?.ok === false ? created : await applyCreatedPositions(projectId, created, normalized);
            if (result?.ok !== false && operation.client_ref) {
              const createdId = result?.id || result?._canvas_id || result?._canvas_node_id;
              if (!createdId) throw new Error("Created node did not return an id for client_ref.");
              refs.set(requireString(operation.client_ref, "client_ref"), String(createdId));
            }
          }
        } else if (op === "duplicate_node") {
          result = await HANDLERS.openreel_duplicate_nodes({
            project_id: projectId,
            node_ids: [operation.node_id],
            title_suffix: operation.title_suffix,
            offset_x: operation.offset_x,
            offset_y: operation.offset_y,
          });
        } else if (op === "update_node") {
          result = await callOpenReelTool("node.update", {
            project_id: projectId,
            node_id: requireString(operation.node_id, "node_id"),
            patch: operation.patch,
          });
        } else if (op === "move_node") {
          result = await setNodePosition(projectId, operation.node_id, { x: operation.x, y: operation.y });
        } else if (op === "connect_nodes") {
          result = await HANDLERS.openreel_connect_nodes({
            project_id: projectId,
            source_node_id: operation.source_node_id,
            target_node_id: operation.target_node_id,
            label: operation.label,
          });
        } else if (op === "update_edge") {
          result = await HANDLERS.openreel_update_edges({
            project_id: projectId,
            edge_id: operation.edge_id,
            label: operation.label,
          });
        } else if (op === "switch_node_history") {
          result = await HANDLERS.openreel_switch_node_history({
            project_id: projectId,
            node_id: operation.node_id,
            history_id: operation.history_id,
            index: operation.index,
          });
        } else {
          throw new Error(`Unsupported canvas patch operation: ${op}`);
        }
        results.push({ index, op, result });
        if (result?.ok === false) {
          return { ok: false, applied_count: index, failed_index: index, results, error: result.error || `${op} failed` };
        }
      } catch (error) {
        return {
          ok: false,
          applied_count: index,
          failed_index: index,
          results,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return { ok: true, applied_count: results.length, results, client_refs: Object.fromEntries(refs) };
  },

  async openreel_delete_canvas_items(args) {
    if (args.confirm !== true) throw new Error("confirm must be true after explicit user authorization.");
    const projectId = requireString(args.project_id, "project_id");
    const result = { ok: true };
    if ((Array.isArray(args.edge_ids) && args.edge_ids.length) || (Array.isArray(args.edges) && args.edges.length)) {
      result.edges = await HANDLERS.openreel_delete_edges({
        project_id: projectId,
        edge_ids: args.edge_ids,
        edges: args.edges,
        confirm: true,
      });
    }
    if (Array.isArray(args.node_ids) && args.node_ids.length) {
      result.nodes = await HANDLERS.openreel_delete_nodes({
        project_id: projectId,
        node_ids: args.node_ids,
        confirm: true,
      });
    }
    if (args.restore_snapshot) {
      result.restore = await HANDLERS.openreel_restore_canvas_snapshot({
        project_id: projectId,
        nodes: args.restore_snapshot.nodes,
        edges: args.restore_snapshot.edges,
        confirm: true,
      });
    }
    if (!result.edges && !result.nodes && !result.restore) {
      throw new Error("Provide node_ids, edge_ids/edges, or restore_snapshot.");
    }
    result.ok = [result.edges, result.nodes, result.restore].filter(Boolean).every((item) => item?.ok !== false);
    return result;
  },

  async openreel_run_nodes(args) {
    const projectId = requireString(args.project_id, "project_id");
    if (!Array.isArray(args.runs) || args.runs.length === 0) throw new Error("runs must be a non-empty array.");
    const results = [];
    for (let index = 0; index < args.runs.length; index += 1) {
      const run = args.runs[index];
      const result = await HANDLERS.openreel_run_node({ project_id: projectId, ...run });
      results.push({ index, node_id: run.node_id, result });
      if (result?.ok === false) {
        return { ok: false, completed_count: index, failed_index: index, results, error: result.error || "Node run failed." };
      }
    }
    return { ok: true, completed_count: results.length, results };
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
    const result = await callOpenReelTool("node.create", omitUndefined({
      project_id: normalized.project_id,
      type: normalized.type,
      fields: normalized.fields,
      name: normalized.name,
      prompt: normalized.prompt,
      parent_node_id: normalized.parent_node_id,
      nodes: normalized.nodes,
    }));
    if (result?.ok === false) return result;
    return applyCreatedPositions(normalized.project_id, result, normalized);
  },

  async openreel_duplicate_nodes(args) {
    const projectId = requireString(args.project_id, "project_id");
    if (!Array.isArray(args.node_ids) || args.node_ids.length === 0) {
      throw new Error("node_ids must be a non-empty array.");
    }
    const suffix = typeof args.title_suffix === "string" ? args.title_suffix : " 副本";
    const offsetX = boundedNumber(args.offset_x, 48, -2000, 2000);
    const offsetY = boundedNumber(args.offset_y, 48, -2000, 2000);
    const duplicates = [];
    for (let index = 0; index < args.node_ids.length; index += 1) {
      const requestedId = requireString(args.node_ids[index], `node_ids[${index}]`);
      const source = await callOpenReelTool("node.get", { project_id: projectId, node_id: requestedId });
      if (!source || source.ok === false || source.error) {
        throw new Error(`Cannot read source node ${requestedId}: ${source?.error || "node.get failed"}`);
      }
      const fields = nodeInputFields(source);
      delete fields.render_state;
      delete fields.uploaded_output;
      const sourceTitle = String(source.title || fields.title || source.type || "节点");
      fields.title = `${sourceTitle}${suffix}`;
      const contract = await requestNodeContract(projectId, source.type, fields);
      if (contract?.ok !== true || contract?.ready !== true) {
        return { ...contractFailure(contract, index), source_node_id: requestedId, duplicates };
      }
      const created = await callOpenReelTool("node.create", {
        project_id: projectId,
        type: source.type,
        fields: contract.normalized_fields ?? fields,
        name: fields.title,
        prompt: source.prompt || fields.prompt,
      });
      if (created?.ok === false) return { ok: false, error: created.error || "Duplicate creation failed.", duplicates };

      let sourcePosition = nodePosition(source);
      if (!sourcePosition) {
        const internalSourceId = await resolveInternalNodeId(projectId, requestedId);
        const detail = await requestOpenReel(
          `/api/projects/${encodeSegment(projectId, "project_id")}/nodes/${encodeSegment(internalSourceId, "node_id")}`,
        );
        sourcePosition = nodePosition(detail);
      }
      const createdId = created?._canvas_id || created?._canvas_node_id || created?.id;
      let placement = null;
      if (sourcePosition && createdId) {
        placement = await setNodePosition(projectId, createdId, {
          x: sourcePosition.x + offsetX * (index + 1),
          y: sourcePosition.y + offsetY * (index + 1),
        });
      }
      duplicates.push({ source_node_id: requestedId, node: created, placement });
    }
    return { ok: true, duplicated_count: duplicates.length, duplicates };
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

  async openreel_move_nodes(args) {
    const projectId = requireString(args.project_id, "project_id");
    const moves = Array.isArray(args.moves)
      ? args.moves
      : [{ node_id: args.node_id, x: args.x, y: args.y }];
    if (moves.length === 0 || moves.some((item) => !item || typeof item !== "object")) {
      throw new Error("Provide node_id/x/y or a non-empty moves array.");
    }
    const results = [];
    for (let index = 0; index < moves.length; index += 1) {
      const item = moves[index];
      results.push(await setNodePosition(projectId, item.node_id, { x: item.x, y: item.y }));
    }
    return { ok: true, moved_count: results.length, results };
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

  async openreel_update_edges(args) {
    const projectId = requireString(args.project_id, "project_id");
    const updates = Array.isArray(args.updates)
      ? args.updates
      : [{ edge_id: args.edge_id, label: args.label }];
    if (updates.length === 0) throw new Error("Provide edge_id/label or a non-empty updates array.");
    const results = [];
    for (let index = 0; index < updates.length; index += 1) {
      const item = updates[index];
      const edgeId = requireString(item?.edge_id, `updates[${index}].edge_id`);
      results.push(await requestOpenReel(
        `/api/projects/${encodeSegment(projectId, "project_id")}/edges/${encodeSegment(edgeId, "edge_id")}`,
        { method: "PATCH", json: { label: typeof item.label === "string" && item.label ? item.label : null } },
      ));
    }
    return { ok: true, updated_count: results.length, results };
  },

  async openreel_delete_edges(args) {
    if (args.confirm !== true) throw new Error("confirm must be true after explicit user authorization.");
    const projectId = requireString(args.project_id, "project_id");
    const targets = [];
    for (const edgeId of Array.isArray(args.edge_ids) ? args.edge_ids : []) {
      targets.push({ edge_id: requireString(edgeId, "edge_id") });
    }
    for (const edge of Array.isArray(args.edges) ? args.edges : []) {
      const [sourceId, targetId] = await Promise.all([
        resolveInternalNodeId(projectId, edge?.source_node_id),
        resolveInternalNodeId(projectId, edge?.target_node_id),
      ]);
      targets.push({ source_node_id: sourceId, target_node_id: targetId });
    }
    if (targets.length === 0) throw new Error("edge_ids or edges must contain at least one edge.");
    const results = [];
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      const edgeId = target.edge_id || `by-endpoints-${index}`;
      const query = target.edge_id
        ? ""
        : `?source_node_id=${encodeURIComponent(target.source_node_id)}&target_node_id=${encodeURIComponent(target.target_node_id)}`;
      results.push(await requestOpenReel(
        `/api/projects/${encodeSegment(projectId, "project_id")}/edges/${encodeSegment(edgeId, "edge_id")}${query}`,
        { method: "DELETE" },
      ));
    }
    return { ok: true, deleted_count: results.length, results };
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

  async openreel_switch_node_history(args) {
    if (!args.history_id && !Number.isInteger(args.index)) {
      throw new Error("history_id or a non-negative index is required.");
    }
    const projectId = requireString(args.project_id, "project_id");
    const internalId = await resolveInternalNodeId(projectId, args.node_id);
    return requestOpenReel(
      `/api/projects/${encodeSegment(projectId, "project_id")}/nodes/${encodeSegment(internalId, "node_id")}/history/switch`,
      { method: "POST", json: omitUndefined({ history_id: args.history_id, index: args.index }) },
    );
  },

  async openreel_restore_canvas_snapshot(args) {
    if (args.confirm !== true) throw new Error("confirm must be true after explicit user authorization.");
    if (!Array.isArray(args.nodes) || !Array.isArray(args.edges)) {
      throw new Error("nodes and edges must be arrays.");
    }
    const projectId = requireString(args.project_id, "project_id");
    return requestOpenReel(`/api/projects/${encodeSegment(projectId, "project_id")}/canvas/restore-snapshot`, {
      method: "POST",
      json: { nodes: args.nodes, edges: args.edges },
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
        "Codex is the OpenReel orchestrator. Read the canvas first, use the typed canvas patch for non-destructive edits, and keep deletion/restoration in the confirmed destructive tool. Never call or delegate to OpenReel /api/chat or its agent loop. Use references for creative dependencies and require explicit user authorization for destructive tools.",
    });
    return;
  }

  if (method === "ping") {
    sendResult(id, {});
    return;
  }

  if (method === "tools/list") {
    sendResult(id, { tools: TOOLS.filter((tool) => EXPOSED_TOOL_NAMES.has(tool.name)) });
    return;
  }

  if (method === "tools/call") {
    const name = String(params?.name ?? "");
    if (!EXPOSED_TOOL_NAMES.has(name)) {
      sendError(id, JsonRpcError.INVALID_PARAMS, `Unknown or private tool: ${name}`);
      return;
    }
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
