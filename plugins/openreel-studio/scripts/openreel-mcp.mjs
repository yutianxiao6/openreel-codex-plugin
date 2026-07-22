#!/usr/bin/env node

import { openAsBlob } from "node:fs";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline";

const SERVER_NAME = "OpenReel Studio Direct Bridge";
const SERVER_VERSION = "0.1.0";
const DEFAULT_PORT_SPEC = "7860-7920,8000-8020";
const DEFAULT_REQUEST_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 15 * 1000;
const DEFAULT_NODE_WAIT_TIMEOUT_SECONDS = 20 * 60;
const CONNECTION_CONFIG_VERSION = 1;
const CONNECTION_ENV_NAMES = [
  "OPENREEL_BASE_URL",
  "OPENREEL_USERNAME",
  "OPENREEL_PASSWORD",
  "OPENREEL_TOKEN",
];

const JsonRpcError = {
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
};

let cachedConnection = null;
let storedConnectionConfig = null;
let storedConnectionConfigLoaded = false;
let storedConnectionConfigError = null;
let selectedProject = null;
let atomicImageImportSupported = null;

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
    video_mode: stringField("Provider-supported video mode. In first_frame mode the first image in references is promoted to the first-frame role automatically."),
    production_path: stringField("Creative production path or method."),
    references: { type: "array", description: "Canonical creative/media dependencies as refs or {ref, role} objects. Put each source here once." },
    depends_on: { type: "array", description: "Execution ordering only. A dependency is not media input unless it also appears in references." },
    reference_images: { type: "array", description: "Direct image inputs for compatibility. Do not repeat an image already present in references." },
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
      "Find and verify a running OpenReel Studio API. A verified explicit connection is saved for later sessions; installed desktop builds are discovered on localhost.",
    inputSchema: objectSchema({
      refresh: booleanField("Clear the cached endpoint and discover OpenReel again.", false),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "openreel_list_projects",
    title: "List OpenReel Projects",
    description: "List OpenReel projects and mark the project selected for this Codex session.",
    inputSchema: objectSchema({
      compact: booleanField("Return compact project identity and selection fields.", true),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "openreel_select_project",
    title: "Select OpenReel Project",
    description:
      "Select the OpenReel project used by later project-scoped tools in this Codex session. Use an id when exact titles are duplicated.",
    inputSchema: objectSchema({
      project_id: stringField("Exact OpenReel project UUID."),
      title: stringField("Exact project title when it uniquely identifies one project."),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "openreel_create_project",
    title: "Create OpenReel Project",
    description: "Create a project, select it for this Codex session, and return its project id.",
    inputSchema: objectSchema(
      { title: stringField("Session name.") },
      ["title"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "openreel_get_project",
    title: "Get OpenReel Session",
    description: "Read the selected OpenReel session id and name.",
    inputSchema: objectSchema(
      { project_id: stringField("Optional project UUID; defaults to the project selected for this Codex session.") },
      [],
    ),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "openreel_update_project",
    title: "Rename OpenReel Session",
    description: "Rename the selected OpenReel session.",
    inputSchema: objectSchema(
      {
        project_id: stringField("Optional project UUID; defaults to the selected project."),
        title: stringField("New session name."),
      },
      ["title"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "openreel_delete_project",
    title: "Delete OpenReel Project",
    description: "Permanently delete a project. confirm_title must exactly match the current project title.",
    inputSchema: objectSchema(
      {
        project_id: stringField("Optional project UUID; defaults to the selected project."),
        confirm_title: stringField("Exact current project title, supplied only after explicit user authorization."),
      },
      ["confirm_title"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "openreel_get_canvas",
    title: "Get OpenReel Canvas",
    description: "Read the full persisted canvas graph, including node positions and edges.",
    inputSchema: objectSchema(
      { project_id: stringField("Optional project UUID; defaults to the selected project.") },
      [],
    ),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "openreel_list_nodes",
    title: "List OpenReel Nodes",
    description: "List the model-visible node index for a project, with optional type, status, surface, or text filters.",
    inputSchema: objectSchema(
      {
        project_id: stringField("Optional project UUID; defaults to the selected project."),
        type: { type: "string", enum: ["text", "image", "video", "audio"], description: "Optional node type." },
        status: stringField("Optional node status."),
        surface: stringField("Optional canvas surface."),
        query: stringField("Optional plain-text search."),
        regex: stringField("Optional regular-expression search."),
        case_sensitive: booleanField("Use case-sensitive matching.", false),
        limit: { type: "integer", minimum: 0, description: "Maximum results; 0 requests all nodes." },
      },
      [],
    ),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "openreel_get_nodes",
    title: "Get OpenReel Node Details",
    description: "Read one or several detailed nodes by id, or locate detailed nodes by text or regex.",
    inputSchema: objectSchema(
      {
        project_id: stringField("Optional project UUID; defaults to the selected project."),
        node_id: stringField("One node id, including a visible id such as #3."),
        node_ids: stringArrayField("Several node ids."),
        query: stringField("Optional plain-text node search."),
        regex: stringField("Optional regular-expression node search."),
        case_sensitive: booleanField("Use case-sensitive matching.", false),
        limit: { type: "integer", minimum: 0, description: "Maximum query matches; 0 requests all." },
      },
      [],
    ),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "openreel_describe_node_contract",
    title: "Describe OpenReel Node Contract",
    description:
      "Read the current project/provider contract and preflight candidate fields as a read-only operation. Returns normalized dynamic defaults, supported values, and field-level errors.",
    inputSchema: objectSchema(
      {
        project_id: stringField("Optional project UUID; defaults to the selected project."),
        type: { type: "string", enum: ["text", "image", "video", "audio"], description: "Node type." },
        fields: nodeFieldsSchema("Candidate fields to validate. OpenReel resolves image dimensions from the current dynamic contract."),
      },
      ["project_id", "type"],
    ),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "openreel_create_nodes",
    title: "Create OpenReel Canvas Nodes",
    description:
      "Preflight and create one text/image/video/audio node or a batch. Call this directly when provider and fields are known; contract errors are returned before creation. Batch items may use client_ref and reference client:<ref>.",
    inputSchema: objectSchema(
      {
        project_id: stringField("Optional project UUID; defaults to the selected project."),
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
      [],
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
    description: "Patch one or several existing nodes in place while preserving their ids and history. Returns compact node identity, status, and changed-field names without echoing large prompts.",
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
      [],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "openreel_move_nodes",
    title: "Move OpenReel Canvas Nodes",
    description: "Set persisted canvas coordinates for one node or a batch. Visible ids such as #3 are resolved first.",
    inputSchema: objectSchema(
      {
        project_id: stringField("Optional project UUID; defaults to the selected project."),
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
      [],
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
        project_id: stringField("Optional project UUID; defaults to the selected project."),
        source_node_id: stringField("Source node id or visible id."),
        target_node_id: stringField("Target node id or visible id."),
        label: stringField("Optional edge label."),
      },
      ["source_node_id", "target_node_id"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "openreel_update_edges",
    title: "Update OpenReel Canvas Edges",
    description: "Update one dependency-edge label or a batch of labels in place.",
    inputSchema: objectSchema(
      {
        project_id: stringField("Optional project UUID; defaults to the selected project."),
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
              label: stringField("New label; an empty string clears it."),
            },
            required: ["edge_id"],
          },
          minItems: 1,
        },
      },
      [],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "openreel_delete_edges",
    title: "Delete OpenReel Canvas Edges",
    description: "Delete dependency edges by id or source/target pair after explicit user authorization.",
    inputSchema: objectSchema(
      {
        project_id: stringField("Optional project UUID; defaults to the selected project."),
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
      ["confirm"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "openreel_delete_nodes",
    title: "Delete OpenReel Canvas Nodes",
    description: "Permanently delete selected nodes and their incident edges. Requires confirm=true after explicit user authorization.",
    inputSchema: objectSchema(
      {
        project_id: stringField("Optional project UUID; defaults to the selected project."),
        node_ids: stringArrayField("Node ids or visible ids to delete."),
        confirm: booleanField("Must be true after the user explicitly authorizes deletion."),
      },
      ["node_ids", "confirm"],
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
        index: { type: "integer", minimum: 0, description: "History index used as the alternative to history_id." },
      },
      ["node_id"],
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
      "Preflight and run an existing node directly through OpenReel's configured provider. Returns a compact task/terminal summary without echoing prompts, resume payloads, or poll history. The OpenReel chat agent remains separate.",
    inputSchema: objectSchema(
      {
        project_id: stringField("OpenReel project UUID."),
        node_id: stringField("Node id or visible id."),
        action: { type: "string", enum: ["run", "render", "force"], description: "Optional node.run action." },
        extra_fields: objectField("Temporary fields applied to the current run."),
        hidden_extra_field_keys: stringArrayField("Temporary keys to remove from persisted output and response."),
        wait: booleanField("Keep this tool call open until OpenReel reports a terminal node event.", true),
        wait_timeout_seconds: {
          type: "integer",
          minimum: 1,
          maximum: 1200,
          default: DEFAULT_NODE_WAIT_TIMEOUT_SECONDS,
          description: "How long OpenReel should hold the server-side event wait. A timeout does not rerun generation.",
        },
      },
      ["node_id"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "openreel_wait_for_node",
    title: "Wait for OpenReel Node",
    description: "Hold one server-side event wait until a persisted node completes, fails, is cancelled, or times out; returns only compact task, media URL, status, and error fields.",
    inputSchema: objectSchema(
      {
        project_id: stringField("Optional project UUID; defaults to the selected project."),
        node_id: stringField("Node id or visible id."),
        timeout_seconds: {
          type: "integer",
          minimum: 1,
          maximum: 1200,
          default: DEFAULT_NODE_WAIT_TIMEOUT_SECONDS,
          description: "How long OpenReel should keep the event wait open; this never starts another generation.",
        },
      },
      ["project_id", "node_id"],
    ),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "openreel_publish_generated_image",
    title: "Publish Codex-Generated Image to OpenReel",
    description:
      "Create a completed OpenReel image node from one local image produced by Codex's built-in image generator. Use this after image_gen by default; a user-selected OpenReel provider uses the node contract, create, and run path.",
    inputSchema: objectSchema(
      {
        project_id: stringField("Optional project UUID; defaults to the selected project."),
        file_path: stringField("Absolute local path returned by Codex image generation."),
        title: stringField("User-visible image node title."),
        prompt: stringField("The final prompt used to generate the image."),
        position: positionSchema("Optional preferred canvas position; OpenReel chooses an open position by default."),
      },
      ["file_path", "title"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "openreel_upload_node_media",
    title: "Upload Media to OpenReel Node",
    description: "Upload a local image or video file as the completed output of an existing matching node.",
    inputSchema: objectSchema(
      {
        project_id: stringField("Optional project UUID; defaults to the selected project."),
        node_id: stringField("Existing image or video node id."),
        file_path: stringField("Absolute local path readable by the Codex host."),
      },
      ["node_id", "file_path"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "openreel_get_model_config",
    title: "Get Masked OpenReel Model Configuration",
    description: "Read OpenReel's parsed model/provider configuration together with masked secret metadata.",
    inputSchema: objectSchema({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "openreel_apply_canvas_patch",
    title: "Apply OpenReel Canvas Patch",
    description:
      "Apply an ordered, typed set of non-destructive canvas mutations. Supported operations create, duplicate, update, or move nodes; connect nodes; update edge labels; and switch node media history.",
    inputSchema: objectSchema(
      {
        project_id: stringField("Optional project UUID; defaults to the selected project."),
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
                label: stringField("New label; an empty string clears it."),
              }, ["op", "edge_id"]),
              objectSchema({
                op: { const: "switch_node_history" },
                node_id: stringField("Image, video, or audio node id."),
                history_id: stringField("History item id."),
                index: { type: "integer", minimum: 0, description: "History index used as the alternative to history_id." },
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
            hidden_extra_field_keys: stringArrayField("Temporary keys kept private to the current run."),
            wait: booleanField("Wait for the persisted terminal state.", true),
            wait_timeout_seconds: {
              type: "integer",
              minimum: 1,
              maximum: 1200,
              default: DEFAULT_NODE_WAIT_TIMEOUT_SECONDS,
            },
          }, ["node_id"]),
        },
      },
      ["project_id", "runs"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "openreel_search_capabilities",
    title: "Search OpenReel Canvas Capabilities",
    description:
      "Search the server-side canvas capability catalog by intent. Returns compact capability ids and summaries; the describe stage loads one selected parameter schema.",
    inputSchema: objectSchema(
      {
        query: stringField("What Codex needs to do, for example create nodes, move layout, run media, or delete an edge."),
        limit: { type: "integer", minimum: 1, maximum: 10, description: "Maximum compact matches; defaults to 6." },
      },
      ["query"],
    ),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "openreel_describe_capability",
    title: "Describe OpenReel Canvas Capability",
    description:
      "Load one discovered capability's exact input schema, safety class, executor name, and usage notes before execution.",
    inputSchema: objectSchema(
      { capability: stringField("Exact capability id returned by openreel_search_capabilities.") },
      ["capability"],
    ),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "openreel_execute_capability",
    title: "Execute OpenReel Canvas Capability",
    description:
      "Execute one previously described non-destructive canvas capability. The bridge verifies schema_ref and validates arguments against the deferred schema.",
    inputSchema: objectSchema(
      {
        project_id: stringField("OpenReel project UUID."),
        capability: stringField("Exact non-destructive capability id."),
        schema_ref: stringField("Exact schema_ref returned by openreel_describe_capability."),
        arguments: objectField("Arguments matching the deferred input_schema; project_id comes from the outer field."),
      },
      ["capability", "schema_ref", "arguments"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "openreel_execute_destructive_capability",
    title: "Execute Destructive OpenReel Canvas Capability",
    description:
      "Execute one previously described destructive canvas capability after explicit user authorization and confirm=true.",
    inputSchema: objectSchema(
      {
        project_id: stringField("OpenReel project UUID."),
        capability: stringField("Exact destructive capability id."),
        schema_ref: stringField("Exact schema_ref returned by openreel_describe_capability."),
        arguments: objectField("Arguments matching the deferred input_schema; project_id and confirm come from the outer fields."),
        confirm: booleanField("Must be true after explicit user authorization."),
      },
      ["capability", "schema_ref", "arguments", "confirm"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
];

const EXPOSED_TOOL_NAMES = new Set([
  "openreel_connection_info",
  "openreel_list_projects",
  "openreel_select_project",
  "openreel_create_project",
  "openreel_get_project",
  "openreel_update_project",
  "openreel_delete_project",
  "openreel_get_canvas",
  "openreel_get_nodes",
  "openreel_describe_node_contract",
  "openreel_create_nodes",
  "openreel_update_nodes",
  "openreel_move_nodes",
  "openreel_delete_nodes",
  "openreel_connect_nodes",
  "openreel_update_edges",
  "openreel_delete_edges",
  "openreel_run_node",
  "openreel_wait_for_node",
  "openreel_publish_generated_image",
  "openreel_upload_node_media",
  "openreel_search_capabilities",
  "openreel_describe_capability",
  "openreel_execute_capability",
  "openreel_execute_destructive_capability",
]);

const PROJECT_SCOPED_TOOL_NAMES = new Set([
  "openreel_get_project",
  "openreel_update_project",
  "openreel_delete_project",
  "openreel_get_canvas",
  "openreel_get_nodes",
  "openreel_describe_node_contract",
  "openreel_create_nodes",
  "openreel_update_nodes",
  "openreel_move_nodes",
  "openreel_delete_nodes",
  "openreel_connect_nodes",
  "openreel_update_edges",
  "openreel_delete_edges",
  "openreel_run_node",
  "openreel_wait_for_node",
  "openreel_publish_generated_image",
  "openreel_upload_node_media",
  "openreel_execute_capability",
  "openreel_execute_destructive_capability",
]);

const CAPABILITY_CATALOG_VERSION = "openreel.canvas.capabilities.v1";
const CAPABILITY_CATALOG = [
  {
    id: "node.duplicate",
    handler: "openreel_duplicate_nodes",
    title: "Duplicate canvas nodes",
    summary: "Copy creative fields into new idle nodes with fresh output history and an offset layout.",
    keywords: "duplicate copy clone offset node 复制 克隆 副本 偏移 节点",
    usage: "Use for editable alternatives; each duplicate starts with fresh generated-output and upload state.",
  },
  {
    id: "node.history.switch",
    handler: "openreel_switch_node_history",
    title: "Switch node media history",
    summary: "Switch an image, video, or audio node to a stored media-history item.",
    keywords: "history version switch media image video audio 历史 版本 切换 媒体 图片 视频 音频",
    usage: "Provide either history_id or a non-negative history index from the node data.",
  },
  {
    id: "canvas.patch",
    handler: "openreel_apply_canvas_patch",
    title: "Apply ordered canvas patch",
    summary: "Apply a mixed ordered batch of create, duplicate, update, move, connect, edge-label, and history-switch operations.",
    keywords: "canvas patch batch transaction ordered workflow client_ref create update move connect 画布 补丁 批量 顺序 工作流 创建 更新 移动 连线",
    usage: "Use for multi-step edits. Later operations may reference a created node through client:<client_ref>; execution stops at the first failure.",
  },
  {
    id: "node.run_many",
    handler: "openreel_run_nodes",
    title: "Run several canvas nodes",
    summary: "Preflight and execute several persisted nodes in order, stopping at the first failure.",
    keywords: "run many batch sequence render generate nodes 批量 依次 运行 渲染 生成 节点",
    usage: "Order upstream nodes before downstream nodes; each run may wait for a terminal result.",
  },
  {
    id: "canvas.snapshot.restore",
    handler: "openreel_restore_canvas_snapshot",
    title: "Restore canvas snapshot",
    summary: "Restore known node and edge snapshots, updating existing matching ids.",
    keywords: "restore recover snapshot canvas nodes edges 恢复 还原 快照 画布 节点 连线",
    usage: "Destructive recovery. Execute with a known snapshot after explicit user authorization.",
    destructive: true,
  },
  {
    id: "canvas.destructive_batch",
    handler: "openreel_delete_canvas_items",
    title: "Delete or restore canvas items in one call",
    summary: "Delete nodes and edges and/or restore a known snapshot through one confirmed destructive operation.",
    keywords: "batch destructive delete restore canvas nodes edges 批量 破坏性 删除 恢复 画布 节点 连线",
    usage: "Destructive. Execute after the user authorizes the complete combined change.",
    destructive: true,
  },
].map((item) => ({ destructive: false, ...item }));

const CAPABILITY_BY_ID = new Map(CAPABILITY_CATALOG.map((item) => [item.id, item]));
const INTERNAL_TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function capabilityInputSchema(capability) {
  const tool = INTERNAL_TOOL_BY_NAME.get(capability.handler);
  if (!tool?.inputSchema) throw new Error(`Capability schema is missing for ${capability.id}.`);
  const schema = cloneJson(tool.inputSchema);
  if (schema.properties) {
    delete schema.properties.project_id;
    delete schema.properties.confirm;
  }
  if (Array.isArray(schema.required)) {
    schema.required = schema.required.filter((name) => name !== "project_id" && name !== "confirm");
  }
  const selectProperties = (names) => Object.fromEntries(
    names.filter((name) => schema.properties?.[name]).map((name) => [name, schema.properties[name]]),
  );
  if (capability.id === "node.create") {
    return {
      oneOf: [
        objectSchema(selectProperties(["type", "fields", "name", "prompt", "parent_node_id", "position"]), ["type"]),
        objectSchema(selectProperties(["nodes"]), ["nodes"]),
      ],
    };
  }
  if (capability.id === "node.update") {
    return {
      oneOf: [
        objectSchema(selectProperties(["node_id", "patch"]), ["node_id", "patch"]),
        objectSchema(selectProperties(["node_ids", "patch"]), ["node_ids", "patch"]),
        objectSchema(selectProperties(["updates"]), ["updates"]),
      ],
    };
  }
  if (capability.id === "node.move") {
    return {
      oneOf: [
        objectSchema(selectProperties(["node_id", "x", "y"]), ["node_id", "x", "y"]),
        objectSchema(selectProperties(["moves"]), ["moves"]),
      ],
    };
  }
  if (capability.id === "edge.update") {
    return {
      oneOf: [
        objectSchema(selectProperties(["edge_id", "label"]), ["edge_id"]),
        objectSchema(selectProperties(["updates"]), ["updates"]),
      ],
    };
  }
  if (capability.id === "edge.delete") {
    return {
      oneOf: [
        objectSchema(selectProperties(["edge_ids"]), ["edge_ids"]),
        objectSchema(selectProperties(["edges"]), ["edges"]),
      ],
    };
  }
  if (capability.id === "node.history.switch") {
    return {
      oneOf: [
        objectSchema(selectProperties(["node_id", "history_id"]), ["node_id", "history_id"]),
        objectSchema(selectProperties(["node_id", "index"]), ["node_id", "index"]),
      ],
    };
  }
  return schema;
}

function capabilitySchemaRef(capability) {
  const digest = createHash("sha256")
    .update(JSON.stringify(capabilityInputSchema(capability)))
    .digest("hex")
    .slice(0, 12);
  return `${CAPABILITY_CATALOG_VERSION}:${capability.id}:${digest}`;
}

function normalizeSearchText(value) {
  return String(value ?? "").trim().toLowerCase();
}

function capabilitySearchScore(capability, query) {
  const normalized = normalizeSearchText(query);
  if (!normalized) return 0;
  const haystack = normalizeSearchText(
    `${capability.id} ${capability.title} ${capability.summary} ${capability.keywords}`,
  );
  if (capability.id === normalized) return 1000;
  let score = haystack.includes(normalized) ? 100 : 0;
  const tokens = normalized.split(/[\s,，、/]+/).filter(Boolean);
  for (const token of tokens) {
    if (capability.id.includes(token)) score += 30;
    else if (normalizeSearchText(capability.title).includes(token)) score += 20;
    else if (haystack.includes(token)) score += 10;
  }
  for (const phrase of normalized.match(/[\u3400-\u9fff]{2,}/g) ?? []) {
    for (let index = 0; index < phrase.length - 1; index += 1) {
      if (haystack.includes(phrase.slice(index, index + 2))) score += 4;
    }
  }
  return score;
}

function schemaTypeMatches(value, type) {
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "array") return Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "null") return value === null;
  return true;
}

function validateSchemaValue(value, schema, pathName = "arguments") {
  if (!schema || typeof schema !== "object") return [];
  if (Array.isArray(schema.oneOf)) {
    const candidates = schema.oneOf.map((candidate) => validateSchemaValue(value, candidate, pathName));
    if (candidates.some((errors) => errors.length === 0)) return [];
    return [`${pathName} does not match any supported schema variant.`];
  }
  const errors = [];
  if (Object.prototype.hasOwnProperty.call(schema, "const") && value !== schema.const) {
    errors.push(`${pathName} must equal ${JSON.stringify(schema.const)}.`);
    return errors;
  }
  if (schema.type && !schemaTypeMatches(value, schema.type)) {
    errors.push(`${pathName} must be ${schema.type}.`);
    return errors;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${pathName} must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}.`);
  }
  if (typeof value === "string") {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) errors.push(`${pathName} is too short.`);
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) errors.push(`${pathName} is too long.`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${pathName} must be >= ${schema.minimum}.`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${pathName} must be <= ${schema.maximum}.`);
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) {
      errors.push(`${pathName} must be > ${schema.exclusiveMinimum}.`);
    }
  }
  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) errors.push(`${pathName} needs at least ${schema.minItems} item(s).`);
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) errors.push(`${pathName} allows at most ${schema.maxItems} item(s).`);
    if (schema.items) {
      value.forEach((item, index) => errors.push(...validateSchemaValue(item, schema.items, `${pathName}[${index}]`)));
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
    for (const required of Array.isArray(schema.required) ? schema.required : []) {
      if (!Object.prototype.hasOwnProperty.call(value, required)) errors.push(`${pathName}.${required} is required.`);
    }
    for (const [key, item] of Object.entries(value)) {
      if (properties[key]) errors.push(...validateSchemaValue(item, properties[key], `${pathName}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${pathName}.${key} is not supported.`);
    }
  }
  return errors;
}

async function executeDeferredCapability(args, destructive) {
  const capabilityId = requireString(args.capability, "capability");
  const capability = CAPABILITY_BY_ID.get(capabilityId);
  if (!capability) {
    return { ok: false, error_kind: "capability_not_found", error: `Unknown capability: ${capabilityId}` };
  }
  if (capability.destructive !== destructive) {
    return {
      ok: false,
      error_kind: "wrong_capability_executor",
      error: capability.destructive
        ? "Use openreel_execute_destructive_capability after explicit user authorization."
        : "Use openreel_execute_capability for this non-destructive capability.",
    };
  }
  if (destructive && args.confirm !== true) {
    return { ok: false, error_kind: "confirmation_required", error: "confirm must be true after explicit user authorization." };
  }
  const expectedRef = capabilitySchemaRef(capability);
  if (args.schema_ref !== expectedRef) {
    return {
      ok: false,
      error_kind: "capability_description_required",
      error: "Call openreel_describe_capability and pass its current schema_ref before execution.",
      capability: capability.id,
    };
  }
  const capabilityArgs = args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments)
    ? args.arguments
    : {};
  const validationErrors = validateSchemaValue(capabilityArgs, capabilityInputSchema(capability));
  if (validationErrors.length) {
    return {
      ok: false,
      error_kind: "capability_arguments_invalid",
      error: "Capability arguments do not match the described schema.",
      validation_errors: validationErrors.slice(0, 20),
      capability: capability.id,
      schema_ref: expectedRef,
    };
  }
  const handler = HANDLERS[capability.handler];
  if (!handler) throw new Error(`Capability handler is missing: ${capability.handler}`);
  return handler({
    ...capabilityArgs,
    project_id: requireString(args.project_id, "project_id"),
    ...(destructive ? { confirm: true } : {}),
  });
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function requireSecret(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
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
    throw new Error("Set OPENREEL_BASE_URL to the service address and provide credentials through OPENREEL_USERNAME and OPENREEL_PASSWORD.");
  }
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function connectionConfigPath() {
  const explicit = String(process.env.OPENREEL_CONFIG_PATH ?? "").trim();
  if (explicit) return path.resolve(explicit);
  if (process.platform === "win32") {
    const appData = String(process.env.APPDATA ?? "").trim() || path.join(homedir(), "AppData", "Roaming");
    return path.join(appData, "OpenReel", "codex-connection.json");
  }
  if (process.platform === "darwin") {
    return path.join(homedir(), "Library", "Application Support", "OpenReel", "codex-connection.json");
  }
  const configHome = String(process.env.XDG_CONFIG_HOME ?? "").trim() || path.join(homedir(), ".config");
  return path.join(configHome, "openreel-codex-plugin", "connection.json");
}

function hasConnectionEnvironment() {
  return CONNECTION_ENV_NAMES.some((name) => Object.prototype.hasOwnProperty.call(process.env, name));
}

function environmentConnectionProfile() {
  return {
    baseUrl: String(process.env.OPENREEL_BASE_URL ?? "").trim(),
    username: String(process.env.OPENREEL_USERNAME ?? "").trim(),
    password: String(process.env.OPENREEL_PASSWORD ?? ""),
    token: String(process.env.OPENREEL_TOKEN ?? "").trim(),
    settingsSource: "environment",
  };
}

function parseStoredConnectionConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("configuration must be an object");
  if (value.version !== CONNECTION_CONFIG_VERSION) throw new Error(`unsupported version: ${value.version}`);
  const baseUrl = normalizeBaseUrl(value.base_url);
  const authentication = value.authentication;
  if (!authentication || typeof authentication !== "object" || Array.isArray(authentication)) {
    throw new Error("authentication must be an object");
  }
  const type = String(authentication.type ?? "");
  if (!new Set(["none", "basic", "bearer"]).has(type)) throw new Error(`unsupported authentication type: ${type}`);
  const profile = {
    baseUrl,
    username: type === "basic" ? requireString(authentication.username, "saved username") : "",
    password: type === "basic" ? requireSecret(authentication.password, "saved password") : "",
    token: type === "bearer" ? requireString(authentication.token, "saved token") : "",
    settingsSource: "saved-config",
  };
  authHeaders(profile);
  return profile;
}

async function loadStoredConnectionConfig() {
  if (storedConnectionConfigLoaded) return storedConnectionConfig;
  storedConnectionConfigLoaded = true;
  try {
    const parsed = JSON.parse(await readFile(connectionConfigPath(), "utf8"));
    storedConnectionConfig = parseStoredConnectionConfig(parsed);
  } catch (error) {
    if (error?.code !== "ENOENT") storedConnectionConfigError = error instanceof Error ? error.message : String(error);
  }
  return storedConnectionConfig;
}

function rememberConnectionEnabled() {
  return !new Set(["0", "false", "no", "off"]).has(String(process.env.OPENREEL_REMEMBER_CONNECTION ?? "1").trim().toLowerCase());
}

function storedAuthentication(profile) {
  const mode = authMode(profile);
  if (mode === "bearer") return { type: "bearer", token: profile.token };
  if (mode === "basic") return { type: "basic", username: profile.username, password: profile.password };
  return { type: "none" };
}

async function saveConnectionConfig(profile, baseUrl) {
  const configPath = connectionConfigPath();
  const directory = path.dirname(configPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const payload = {
    version: CONNECTION_CONFIG_VERSION,
    base_url: baseUrl,
    authentication: storedAuthentication(profile),
    updated_at: new Date().toISOString(),
  };
  const temporaryPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, configPath);
    await chmod(configPath, 0o600);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
  storedConnectionConfig = { ...profile, baseUrl, settingsSource: "saved-config" };
  storedConnectionConfigLoaded = true;
  storedConnectionConfigError = null;
  return configPath;
}

async function forgetConnectionConfig() {
  const configPath = connectionConfigPath();
  let removed = true;
  try {
    await unlink(configPath);
  } catch (error) {
    if (error?.code === "ENOENT") removed = false;
    else throw error;
  }
  cachedConnection = null;
  storedConnectionConfig = null;
  storedConnectionConfigLoaded = true;
  storedConnectionConfigError = null;
  selectedProject = null;
  atomicImageImportSupported = null;
  return { ok: true, removed, config_path: configPath };
}

async function resolveConnectionProfile() {
  if (hasConnectionEnvironment()) return environmentConnectionProfile();
  const saved = await loadStoredConnectionConfig();
  if (saved) return saved;
  if (storedConnectionConfigError) {
    throw new Error(`Saved OpenReel connection configuration is invalid: ${storedConnectionConfigError}`);
  }
  return { baseUrl: "", username: "", password: "", token: "", settingsSource: "localhost-discovery" };
}

function authHeaders(profile) {
  const token = String(profile?.token ?? "").trim();
  if (token) return { Authorization: `Bearer ${token}` };
  const username = String(profile?.username ?? "").trim();
  const password = String(profile?.password ?? "");
  if (username || password) {
    if (!username || !password) {
      throw new Error("OPENREEL_USERNAME and OPENREEL_PASSWORD must be provided together.");
    }
    return { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` };
  }
  return {};
}

function authMode(profile) {
  if (String(profile?.token ?? "").trim()) return "bearer";
  if (String(profile?.username ?? "").trim()) return "basic";
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

async function probeOpenReel(baseUrl, profile) {
  try {
    const response = await fetch(apiUrl(baseUrl, "/api/health"), {
      headers: { Accept: "application/json", ...authHeaders(profile) },
      signal: AbortSignal.timeout(boundedNumber(
        process.env.OPENREEL_DISCOVERY_TIMEOUT_MS,
        DEFAULT_DISCOVERY_TIMEOUT_MS,
        1000,
        60 * 1000,
      )),
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
  if (refresh) {
    cachedConnection = null;
    atomicImageImportSupported = null;
  }
  if (cachedConnection) return cachedConnection;

  const profile = await resolveConnectionProfile();
  authHeaders(profile);
  const explicit = profile.baseUrl;
  if (explicit) {
    const baseUrl = normalizeBaseUrl(explicit);
    const health = await probeOpenReel(baseUrl, profile);
    if (!health) {
      throw new Error(
        `OPENREEL_BASE_URL did not return a verified OpenReel health response: ${baseUrl}. ` +
          "Check that OpenReel is running and that OPENREEL_USERNAME/OPENREEL_PASSWORD or OPENREEL_TOKEN is correct.",
      );
    }
    let credentialsSaved = profile.settingsSource === "saved-config";
    let configurationWarning = null;
    if (profile.settingsSource === "environment" && rememberConnectionEnabled()) {
      try {
        await saveConnectionConfig(profile, baseUrl);
        credentialsSaved = true;
      } catch (error) {
        configurationWarning = `Connected, but could not save the private connection configuration: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    cachedConnection = {
      baseUrl,
      health,
      source: profile.settingsSource === "saved-config" ? "saved-config" : "explicit",
      settingsSource: profile.settingsSource,
      profile,
      credentialsSaved,
      configurationWarning,
    };
    return cachedConnection;
  }

  const ports = parsePortSpec(process.env.OPENREEL_DISCOVERY_PORTS);
  const candidates = ports.map((port) => `http://127.0.0.1:${port}`);
  for (let offset = 0; offset < candidates.length; offset += 24) {
    const batch = candidates.slice(offset, offset + 24);
    const results = await Promise.all(batch.map(async (baseUrl) => ({ baseUrl, health: await probeOpenReel(baseUrl, profile) })));
    const match = results.find((item) => item.health);
    if (match) {
      cachedConnection = {
        ...match,
        source: "localhost-discovery",
        settingsSource: "localhost-discovery",
        profile,
        credentialsSaved: false,
        configurationWarning: null,
      };
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
  const headers = { Accept: "application/json", ...authHeaders(connection.profile), ...(options.headers ?? {}) };
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

function unsupportedAtomicImageImport(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /failed \((404|405)\)/.test(message);
}

async function localMediaFile(filePath, expectedKind = null) {
  const resolvedPath = path.resolve(requireString(filePath, "file_path"));
  const fileStat = await stat(resolvedPath);
  if (!fileStat.isFile()) throw new Error("file_path must point to a regular file.");
  const mimeType = mimeTypeFor(resolvedPath);
  if (expectedKind === "image" && !mimeType.startsWith("image/")) {
    throw new Error("file_path must point to an image file supported by OpenReel.");
  }
  return { filePath: resolvedPath, mimeType };
}

async function uploadLocalNodeMedia(projectId, nodeId, filePath, { resolveNode = true } = {}) {
  const local = await localMediaFile(filePath);
  const internalId = resolveNode ? await resolveInternalNodeId(projectId, nodeId) : requireString(nodeId, "node_id");
  const blob = await openAsBlob(local.filePath, { type: local.mimeType });
  const form = new FormData();
  form.append("file", blob, path.basename(local.filePath));
  return requestOpenReel(
    `/api/projects/${encodeSegment(projectId, "project_id")}/nodes/${encodeSegment(internalId, "node_id")}/media`,
    { method: "POST", body: form },
  );
}

function publishedImageResult(result, transport) {
  return {
    ok: result?.ok !== false,
    generation_backend: "codex_builtin",
    transport,
    node_id: result?.id ?? result?._canvas_id ?? result?._canvas_node_id,
    title: result?.title,
    status: result?.status,
    position: result?.position,
    media: result?.uploaded_media ?? result?.output,
  };
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
    contract: compactNodeContract(contract),
    hint: "Repair the reported fields, preflight the revised values, and retry creation on the intended node path.",
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
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requested)) {
    return requested;
  }
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

async function waitForNode({
  project_id,
  node_id,
  timeout_seconds = DEFAULT_NODE_WAIT_TIMEOUT_SECONDS,
}) {
  const projectId = requireString(project_id, "project_id");
  const internalId = await resolveInternalNodeId(projectId, node_id);
  const timeoutSeconds = boundedNumber(timeout_seconds, DEFAULT_NODE_WAIT_TIMEOUT_SECONDS, 1, 1200);
  const query = new URLSearchParams({ timeout_seconds: String(timeoutSeconds) });
  const result = await requestOpenReel(
    `/api/projects/${encodeSegment(projectId, "project_id")}/nodes/${encodeSegment(internalId, "node_id")}/wait?${query}`,
    { timeoutMs: timeoutSeconds * 1000 + 30 * 1000 },
  );
  const compact = compactWaitResult(result);
  if (compact.terminal !== false) return compact;
  return {
    ...compact,
    hint: "Continue with openreel_wait_for_node on this node. Do not call openreel_run_node again unless the user explicitly requests a new generation.",
    next: {
      tool: "openreel_wait_for_node",
      arguments: { project_id: projectId, node_id: internalId },
    },
  };
}

function omitUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function compactString(value, limit = 800) {
  if (typeof value !== "string") return value;
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}… [${value.length - limit} chars omitted]`;
}

function compactArray(value, limit = 10) {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, limit).map((item) => {
    if (typeof item === "string") return compactString(item, 300);
    const record = objectValue(item);
    if (!record) return item;
    return omitUndefined({
      field: record.field,
      code: record.code,
      message: compactString(record.message, 400),
      kind: record.kind,
      actual: record.actual,
      minimum: record.minimum,
      maximum: record.maximum,
      supported: Array.isArray(record.supported) ? record.supported.slice(0, 20) : record.supported,
      error: compactString(record.error, 400),
    });
  });
}

function nestedResultSources(value) {
  const root = objectValue(value);
  if (!root) return [];
  const sources = [];
  const add = (candidate) => {
    const record = objectValue(candidate);
    if (record && !sources.includes(record)) sources.push(record);
  };
  add(root);
  add(root.result);
  add(root.output);
  add(root.node);
  add(objectValue(root.node)?.output);
  add(objectValue(root.result)?.result);
  add(objectValue(root.result)?.output);
  return sources;
}

function firstResultValue(sources, ...keys) {
  for (const source of sources) {
    for (const key of keys) {
      const value = source[key];
      if (value !== undefined && value !== null && value !== "") return value;
    }
  }
  return undefined;
}

function compactProgress(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return compactString(value, 200);
  return omitUndefined({
    percent: value.percent ?? value.progress,
    status: value.status,
    message: compactString(value.message, 300),
  });
}

function compactMediaResult(value) {
  const sources = nestedResultSources(value);
  if (!sources.length) return {};
  const read = (...keys) => firstResultValue(sources, ...keys);
  return omitUndefined({
    ok: read("ok"),
    node_id: read("node_id", "_canvas_node_id", "_canvas_id", "id"),
    type: read("type", "node_type"),
    status: read("status"),
    async: read("async"),
    job_id: read("job_id"),
    provider_task_id: read("provider_task_id"),
    provider: read("provider"),
    model: read("model"),
    mode: read("video_mode", "mode"),
    asset_id: read("asset_id"),
    asset_ids: compactArray(read("asset_ids")),
    url: compactString(read("local_url", "url", "remote_url"), 2000),
    remote_url: compactString(read("remote_url"), 2000),
    thumbnail_url: compactString(read("thumbnail_url"), 2000),
    last_frame_url: compactString(read("last_frame_url"), 2000),
    duration_seconds: read("duration_seconds"),
    aspect_ratio: read("aspect_ratio"),
    resolution: read("resolution"),
    progress: compactProgress(read("progress")),
    error: compactString(read("error", "error_message"), 1000),
    error_kind: read("error_kind"),
    provider_msg: compactString(read("provider_msg"), 800),
    retryable: read("retryable"),
    adapter_resume_supported: read("adapter_resume_supported"),
    resumed_existing_job: read("resumed_existing_job"),
    hint: compactString(read("hint"), 800),
    errors: compactArray(read("errors", "validation_errors"), 10),
    warnings: compactArray(read("warnings", "reference_warnings"), 10),
  });
}

function compactNode(node) {
  const record = objectValue(node);
  if (!record) return undefined;
  return omitUndefined({
    id: record.id ?? record.node_id,
    node_id: record.node_id ?? record.id,
    _canvas_node_id: record._canvas_node_id ?? record._canvas_id,
    display_id: record.display_id ?? record._canvas_display_id,
    type: record.type ?? record.node_type,
    title: compactString(record.title, 300),
    status: record.status,
    error_message: compactString(record.error_message, 800),
  });
}

function compactWaitResult(result) {
  const record = objectValue(result) ?? {};
  const media = compactMediaResult(record.node?.output ?? record);
  const node = compactNode(record.node);
  return omitUndefined({
    ...media,
    ok: record.ok ?? media.ok,
    terminal: record.terminal,
    generation_failed: record.generation_failed,
    run_continues: record.run_continues,
    status: record.status ?? node?.status ?? media.status,
    elapsed_seconds: record.elapsed_seconds,
    node_id: node?.id ?? media.node_id,
    node,
  });
}

function compactNodeMutationResult(result) {
  const record = objectValue(result) ?? {};
  if (Array.isArray(record.nodes) || Array.isArray(record.results)) {
    const items = record.nodes ?? record.results;
    return omitUndefined({
      ok: record.ok !== false,
      status: record.status,
      created_count: record.created_count,
      updated_count: record.updated_count,
      nodes: items.map((item) => ({
        index: item?.index,
        ...compactNode(item?.node ?? item),
        ...compactMediaResult(item),
      })),
      errors: compactArray(record.errors, 20),
    });
  }
  const node = compactNode(record) ?? {};
  const media = compactMediaResult(record);
  const changedFields = objectValue(record.changes) ? Object.keys(record.changes) : undefined;
  return omitUndefined({
    ...node,
    ...media,
    ok: record.ok !== false,
    changed_fields: changedFields,
    placements: Array.isArray(record.placements)
      ? record.placements.slice(0, 20).map((item) => compactNode(item) ?? item)
      : undefined,
  });
}

function compactNodeContract(contract) {
  const record = objectValue(contract) ?? {};
  const normalized = objectValue(record.normalized_fields) ?? {};
  const omittedInputFields = [];
  const normalizedFields = {};
  for (const [key, value] of Object.entries(normalized)) {
    if (new Set(["prompt", "content", "description"]).has(key)) {
      omittedInputFields.push(key);
      continue;
    }
    normalizedFields[key] = Array.isArray(value)
      ? value.slice(0, 20)
      : compactString(value, 500);
  }
  const capabilities = objectValue(record.capabilities) ?? {};
  return omitUndefined({
    ok: record.ok,
    ready: record.ready,
    contract_version: record.contract_version,
    node_type: record.node_type,
    required_fields: compactArray(record.required_fields, 40),
    optional_fields: compactArray(record.optional_fields, 60),
    normalized_fields: normalizedFields,
    omitted_input_fields: omittedInputFields.length ? omittedInputFields : undefined,
    provider: record.provider,
    available_providers: Array.isArray(record.available_providers)
      ? record.available_providers.slice(0, 30)
      : undefined,
    capabilities: omitUndefined({
      supported_modes: compactArray(capabilities.supported_modes, 30),
      supported_aspect_ratios: compactArray(capabilities.supported_aspect_ratios, 30),
      supported_resolutions: compactArray(capabilities.supported_resolutions, 30),
      supported_sizes: compactArray(capabilities.supported_sizes, 30),
      default_aspect_ratio: capabilities.default_aspect_ratio,
      default_resolution: capabilities.default_resolution,
      duration: capabilities.duration,
      reference_limits: capabilities.reference_limits,
      result_type: capabilities.result_type,
    }),
    effective_video_mode: record.effective_video_mode,
    reference_counts: record.reference_counts,
    errors: compactArray(record.errors, 20),
    warnings: compactArray(record.warnings, 20),
    repair: record.repair,
    response_compacted: true,
  });
}

function sessionProject(project) {
  if (!project || typeof project !== "object") return project;
  return {
    id: project.id,
    title: project.title,
  };
}

function selectedProjectSummary() {
  if (!selectedProject) return null;
  return {
    id: selectedProject.id,
    title: selectedProject.title ?? null,
  };
}

function bindProject(project) {
  const id = requireString(project?.id, "project.id");
  selectedProject = {
    id,
    title: typeof project?.title === "string" ? project.title : null,
  };
  return selectedProjectSummary();
}

function resolveSelectedProjectId(requestedProjectId) {
  const requested = typeof requestedProjectId === "string" && requestedProjectId.trim()
    ? requestedProjectId.trim()
    : null;
  if (requested && selectedProject && requested !== selectedProject.id) {
    throw new Error(
      `Project ${selectedProject.id}${selectedProject.title ? ` (${selectedProject.title})` : ""} is selected. ` +
        `Call openreel_select_project before operating project ${requested}.`,
    );
  }
  if (requested && !selectedProject) {
    selectedProject = { id: requested, title: null };
    return requested;
  }
  if (requested) return requested;
  if (selectedProject) return selectedProject.id;
  throw new Error("No OpenReel project is selected. Call openreel_list_projects, then openreel_select_project.");
}

async function selectProject(args) {
  const requestedId = typeof args.project_id === "string" && args.project_id.trim() ? args.project_id.trim() : null;
  const requestedTitle = typeof args.title === "string" && args.title.trim() ? args.title.trim() : null;
  if ((requestedId ? 1 : 0) + (requestedTitle ? 1 : 0) !== 1) {
    throw new Error("Provide exactly one of project_id or title.");
  }

  let project;
  if (requestedId) {
    project = await requestOpenReel(`/api/projects/${encodeSegment(requestedId, "project_id")}`);
  } else {
    const projects = await requestOpenReel("/api/projects?compact=true");
    const matches = (Array.isArray(projects) ? projects : []).filter((item) => item?.title === requestedTitle);
    if (matches.length === 0) throw new Error(`No OpenReel project has the exact title: ${requestedTitle}`);
    if (matches.length > 1) {
      throw new Error(`Several OpenReel projects have the exact title: ${requestedTitle}. Select one by project_id.`);
    }
    project = matches[0];
  }

  const previous = selectedProjectSummary();
  const selected = bindProject(project);
  return {
    ok: true,
    changed: previous?.id !== selected.id,
    previous_project: previous,
    selected_project: selected,
    project: sessionProject(project),
  };
}

function publicConnectionInfo(connection) {
  const parsed = new URL(connection.baseUrl);
  return {
    ok: true,
    api_base: connection.baseUrl,
    source: connection.source,
    settings_source: connection.settingsSource,
    installation_mode: ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)
      ? "local-installed-or-source"
      : "remote-or-docker",
    authentication: authMode(connection.profile),
    connection_saved: connection.credentialsSaved,
    selected_project: selectedProjectSummary(),
    config_path: connectionConfigPath(),
    ...(connection.configurationWarning ? { configuration_warning: connection.configurationWarning } : {}),
    health: connection.health,
    direct_control: true,
    openreel_chat_agent_used: false,
  };
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
    return publicConnectionInfo(connection);
  },

  async openreel_list_projects(args) {
    const compact = args.compact !== false;
    const projects = await requestOpenReel(`/api/projects?compact=${compact ? "true" : "false"}`);
    if (!Array.isArray(projects)) return projects;
    if (selectedProject && selectedProject.title === null) {
      const selected = projects.find((project) => project?.id === selectedProject.id);
      if (selected && typeof selected.title === "string") selectedProject.title = selected.title;
    }
    return projects.map((project) => ({
      ...sessionProject(project),
      _codex_selected: project?.id === selectedProject?.id,
    }));
  },

  async openreel_select_project(args) {
    return selectProject(args);
  },

  async openreel_create_project(args) {
    const body = { title: requireString(args.title, "title") };
    const project = await requestOpenReel("/api/projects", { method: "POST", json: body });
    bindProject(project);
    return { id: project.id, title: project.title, _codex_selected: true };
  },

  async openreel_get_project(args) {
    const projectId = encodeSegment(args.project_id, "project_id");
    const project = await requestOpenReel(`/api/projects/${projectId}`);
    bindProject(project);
    return sessionProject(project);
  },

  async openreel_update_project(args) {
    const projectId = encodeSegment(args.project_id, "project_id");
    const title = requireString(args.title, "title");
    const project = await requestOpenReel(`/api/projects/${projectId}`, { method: "PATCH", json: { title } });
    if (project?.id) bindProject(project);
    else if (selectedProject) selectedProject.title = title;
    return { id: project?.id ?? projectId, title: project?.title ?? title };
  },

  async openreel_delete_project(args) {
    const projectIdRaw = requireString(args.project_id, "project_id");
    const projectId = encodeSegment(projectIdRaw, "project_id");
    const project = await requestOpenReel(`/api/projects/${projectId}`);
    if (requireString(args.confirm_title, "confirm_title") !== String(project?.title ?? "")) {
      throw new Error("confirm_title does not exactly match the current OpenReel project title.");
    }
    const result = await requestOpenReel(`/api/projects/${projectId}`, { method: "DELETE" });
    if (selectedProject?.id === projectIdRaw) selectedProject = null;
    return result;
  },

  async openreel_get_canvas(args) {
    const projectId = encodeSegment(args.project_id, "project_id");
    return requestOpenReel(`/api/projects/${projectId}/nodes`);
  },

  async openreel_search_capabilities(args) {
    const query = requireString(args.query, "query");
    const limit = boundedNumber(args.limit, 6, 1, 10);
    const matches = CAPABILITY_CATALOG
      .map((capability) => ({ capability, score: capabilitySearchScore(capability, query) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.capability.id.localeCompare(right.capability.id))
      .slice(0, limit)
      .map(({ capability }) => ({
        capability: capability.id,
        title: capability.title,
        summary: capability.summary,
        destructive: capability.destructive,
        next: "Call openreel_describe_capability with this exact capability id.",
      }));
    return {
      ok: true,
      query,
      matches,
      total: matches.length,
      catalog_version: CAPABILITY_CATALOG_VERSION,
    };
  },

  async openreel_describe_capability(args) {
    const capabilityId = requireString(args.capability, "capability");
    const capability = CAPABILITY_BY_ID.get(capabilityId);
    if (!capability) {
      return {
        ok: false,
        error_kind: "capability_not_found",
        error: `Unknown capability: ${capabilityId}`,
        hint: "Use openreel_search_capabilities to discover a current capability id.",
      };
    }
    return {
      ok: true,
      capability: capability.id,
      title: capability.title,
      summary: capability.summary,
      usage: capability.usage,
      destructive: capability.destructive,
      executor: capability.destructive
        ? "openreel_execute_destructive_capability"
        : "openreel_execute_capability",
      schema_ref: capabilitySchemaRef(capability),
      input_schema: capabilityInputSchema(capability),
      catalog_version: CAPABILITY_CATALOG_VERSION,
    };
  },

  async openreel_execute_capability(args) {
    return executeDeferredCapability(args, false);
  },

  async openreel_execute_destructive_capability(args) {
    return executeDeferredCapability(args, true);
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
    return compactNodeContract(await requestNodeContract(args.project_id, args.type, args.fields ?? {}));
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
    return compactNodeMutationResult(await applyCreatedPositions(normalized.project_id, result, normalized));
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
    const result = await callOpenReelTool("node.update", omitUndefined({
      project_id: args.project_id,
      node_id: args.node_id,
      patch: args.patch,
      updates: args.updates,
      node_ids: args.node_ids,
    }));
    return compactNodeMutationResult(result);
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
    const compactRun = compactMediaResult(result);
    if (args.wait === false || result?.ok === false) return compactRun;
    const nodeId = result?._canvas_node_id || result?._canvas_id || args.node_id;
    const waited = await waitForNode({
      project_id: args.project_id,
      node_id: nodeId,
      timeout_seconds: args.wait_timeout_seconds ?? DEFAULT_NODE_WAIT_TIMEOUT_SECONDS,
    });
    return { ok: waited.ok, run_result: compactRun, wait_result: waited };
  },

  async openreel_wait_for_node(args) {
    return waitForNode(args);
  },

  async openreel_publish_generated_image(args) {
    const projectId = requireString(args.project_id, "project_id");
    const title = requireString(args.title, "title");
    const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
    const local = await localMediaFile(args.file_path, "image");

    if (atomicImageImportSupported !== false) {
      const form = new FormData();
      form.append("file", await openAsBlob(local.filePath, { type: local.mimeType }), path.basename(local.filePath));
      form.append("title", title);
      form.append("generation_backend", "codex_builtin");
      form.append("creator", "agent");
      if (prompt) form.append("prompt", prompt);
      if (args.position) {
        form.append("x", String(args.position.x));
        form.append("y", String(args.position.y));
      }
      try {
        const imported = await requestOpenReel(
          `/api/projects/${encodeSegment(projectId, "project_id")}/nodes/import-image`,
          { method: "POST", body: form },
        );
        atomicImageImportSupported = true;
        return publishedImageResult(imported, "atomic_import");
      } catch (error) {
        if (!unsupportedAtomicImageImport(error)) throw error;
        atomicImageImportSupported = false;
      }
    }

    const position = args.position && typeof args.position === "object" ? args.position : {};
    const created = await requestOpenReel(`/api/projects/${encodeSegment(projectId, "project_id")}/nodes`, {
      method: "POST",
      json: {
        type: "image",
        title,
        x: Number.isFinite(Number(position.x)) ? Number(position.x) : 120,
        y: Number.isFinite(Number(position.y)) ? Number(position.y) : 90,
      },
    });
    const nodeId = requireString(created?.id, "created node id");
    try {
      const uploaded = await uploadLocalNodeMedia(projectId, nodeId, local.filePath, { resolveNode: false });
      return publishedImageResult(uploaded, "legacy_create_then_upload");
    } catch (error) {
      return {
        ok: false,
        error_kind: "generated_image_upload_failed",
        error: error instanceof Error ? error.message : String(error),
        node_id: nodeId,
        retry_tool: "openreel_upload_node_media",
        retry_arguments: { node_id: nodeId, file_path: local.filePath },
        hint: "Retry the upload on this existing node with the same generated image file.",
      };
    }
  },

  async openreel_upload_node_media(args) {
    const projectId = requireString(args.project_id, "project_id");
    return uploadLocalNodeMedia(projectId, args.node_id, args.file_path);
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
        "Codex orchestrates OpenReel through the openreel_* tools. Start with connection verification and exact project selection, then read the minimum state required for the request. Use direct project, node, edge, contract, single-run, server-wait, publish, and upload tools for common work. Call openreel_create_nodes directly when media fields are known because it preflights internally; use openreel_describe_node_contract only for provider discovery or field repair. Use openreel_search_capabilities → openreel_describe_capability → the returned executor only for uncommon operations. For image creation, use Codex imagegen → openreel_publish_generated_image by default. Video uses the OpenReel create → run path; list each media source once in fields.references, and do not mirror it into reference_images or depends_on. OpenReel and UMA own provider requests and upstream polling, while the bridge holds one event-driven server wait and returns a compact terminal summary. A non-terminal wait timeout means continue waiting on the same node, never rerun it implicitly. Obtain explicit authorization for destructive actions. OpenReel /api/chat remains the separate built-in-agent path.",
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
      const requestedArgs = params?.arguments ?? {};
      const toolArgs = PROJECT_SCOPED_TOOL_NAMES.has(name)
        ? { ...requestedArgs, project_id: resolveSelectedProjectId(requestedArgs.project_id) }
        : requestedArgs;
      const data = await handler(toolArgs);
      sendResult(id, toolResult(data, data?.ok === false));
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      sendResult(id, toolResult({ ok: false, error: messageText }, true));
    }
    return;
  }

  if (id !== undefined) sendError(id, JsonRpcError.METHOD_NOT_FOUND, `Method not found: ${method}`);
}

if (process.argv.includes("--forget-connection")) {
  try {
    process.stdout.write(`${JSON.stringify(await forgetConnectionConfig(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
} else if (process.argv.includes("--check")) {
  try {
    const connection = await discoverConnection({ refresh: true });
    process.stdout.write(`${JSON.stringify(publicConnectionInfo(connection), null, 2)}\n`);
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
