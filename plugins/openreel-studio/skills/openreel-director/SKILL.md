---
name: openreel-director
description: Let Codex directly operate a running OpenReel Studio installation, including projects, canvas nodes, dependencies, media uploads, model-aware node authoring, and node runs. Use when the user asks Codex to inspect, build, edit, troubleshoot, or run work inside OpenReel instead of delegating to OpenReel's own chat agent.
---

# OpenReel Direct Director

This is an opt-in control mode. Installing the plugin does not replace OpenReel's default chat agent. Use it only when the user explicitly asks Codex to connect to or operate OpenReel; then Codex is the reasoning and orchestration agent for that requested work. The OpenReel bridge is an atomic control surface for projects, canvas nodes, edges, uploads, configuration reads, and node execution.

## Connection

1. Call `openreel_connection_info` before the first OpenReel operation in a thread.
2. Do not connect, inspect projects, or change the OpenReel chat mode merely because the plugin is installed. Activation is a user choice.
3. Installed desktop builds start a verified loopback API on a dynamic port. The bridge discovers it automatically; the user only needs to start OpenReel.
4. Source builds are discovered on their normal local ports.
5. Docker and remote deployments use the explicit `OPENREEL_BASE_URL`; Basic or bearer authentication comes from the documented environment variables.
6. If discovery fails, tell the user to start the installed app. Ask for remote configuration only when the intended target is not local.

## Direct-control boundary

- Use the `openreel_*` MCP tools. They call OpenReel project endpoints and atomic registry tools directly.
- Do not call `/api/chat`, send slash commands, or ask OpenReel's Agent Loop to decide or execute the work.
- Production methods and prompt-writing knowledge come from Codex skills. The bridge does not expose OpenReel's internal skills. Running `node.run` invokes the node's configured model/provider, not the OpenReel chat agent.
- Keep Codex's own plan and reasoning in the Codex conversation. Persist user-visible creative truth as OpenReel `text`, `image`, `video`, or `audio` nodes.

## Operating sequence

1. Connect, then call `openreel_list_projects` and select the exact project id. Create a project only when the user asks for a new one.
2. Read `openreel_get_canvas` before changing an existing canvas. It returns the persisted nodes, their fields and positions, media history, and edges in one graph snapshot.
3. Use the applicable Codex skill for production method and prompt guidance. OpenReel contributes runtime state and model contracts, not an additional skill layer.
4. Before creating each node type, call `openreel_describe_node_contract` with the candidate fields. Use its `normalized_fields`, dynamic provider defaults, supported values, and field-level errors; `openreel_apply_canvas_patch` repeats this preflight for every `create_node` and refuses invalid writes.
5. Apply ordered canvas changes with `openreel_apply_canvas_patch`. Use `fields.references` in `create_node` or `update_node` operations for creative dependencies; use `connect_nodes` only when a direct graph edge is specifically needed.
6. For image nodes, provide both `aspect_ratio` and an exact matching `resolution` such as `1920x1080`. The contract may read them from current project output settings but never invents a hardcoded image size when they are absent.
7. For image, video, or audio generation, write the production prompt and model-facing fields before calling `openreel_run_nodes`; the bridge reads each persisted node and repeats the dynamic contract preflight before provider execution.
8. Wait for the persisted terminal state and inspect the output. A provider accepting a job is not proof that the node completed.
9. Repair failed nodes in place with an `update_node` patch operation, then rerun the same node unless the user explicitly wants an alternative node.

## Canvas handling

- Treat ids returned by OpenReel as authoritative. Visible ids such as `#3` are accepted by the bridge and resolved before raw canvas operations.
- Preserve existing nodes and user-authored material. Read before update and patch only relevant fields.
- A `create_node` operation may declare `client_ref`; later operations in the same patch can use `client:<ref>` anywhere an id or nested reference is accepted.
- Use `move_node`, `update_edge`, and `switch_node_history` patch operations for persisted layout and history changes. Arrange a readable flow and avoid moving unrelated nodes.
- Use `duplicate_node` for editable copies. It copies creative fields into a new idle node and deliberately excludes generated output history.
- Use `openreel_delete_canvas_items` only after explicit authorization to delete nodes/edges or recover a known node-and-edge snapshot.
- Uploading media requires an existing matching image or video node; the upload becomes that node's completed output.

## Models and protocols

- Treat `openreel_describe_node_contract` as the authoritative merged view for the current project, provider, model profile, video mode, and candidate fields. Do not bypass a `ready=false` result.
- Do not invent provider ids, model ids, image counts, reference limits, durations, or resolutions when these can be read from OpenReel.

## Safety

- Node/edge deletion and canvas snapshot restoration require explicit user authorization and `openreel_delete_canvas_items(confirm=true)`.
- Read-only diagnosis does not authorize deletion, media generation, model spending, or broad canvas rewrites.
- Never expose OpenReel credentials or masked secret values in the response.
