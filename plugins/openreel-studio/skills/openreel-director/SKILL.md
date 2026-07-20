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
- Reading `skill.search` or `skill.get` through the bridge reads production knowledge only. Running `node.run` invokes the node's configured model/provider, not the OpenReel chat agent.
- Keep Codex's own plan and reasoning in the Codex conversation. Persist user-visible creative truth as OpenReel `text`, `image`, `video`, or `audio` nodes.

## Operating sequence

1. Connect, then call `openreel_list_projects` and select the exact project id. Create a project only when the user asks for a new one.
2. Read `openreel_get_canvas` or `openreel_list_nodes` before changing an existing canvas. Use `openreel_get_nodes` for full fields and outputs.
3. For a production workflow or unfamiliar media method, call `openreel_search_skills` with an explicit `workflow`, `prompt`, or `review` category, then read only the relevant skill.
4. Create or update nodes. Use `fields.references` for creative dependencies so OpenReel owns and displays the corresponding edges. Use `openreel_connect_nodes` only when a direct graph edge is specifically needed.
5. For image nodes, provide both `aspect_ratio` and an exact matching `resolution` such as `1920x1080`; read current project or model settings instead of inventing a tier label.
6. For image, video, or audio generation, write the production prompt and model-facing fields before calling `openreel_run_node`.
7. Wait for the persisted terminal state and inspect the output. A provider accepting a job is not proof that the node completed.
8. Repair failed nodes in place with `openreel_update_nodes`, then rerun the same node unless the user explicitly wants an alternative node.

## Canvas handling

- Treat ids returned by OpenReel as authoritative. Visible ids such as `#3` are accepted by the bridge and resolved before raw canvas operations.
- Preserve existing nodes and user-authored material. Read before update and patch only relevant fields.
- Batch creation may use `client_ref`. Later batch items can refer to earlier ones with `client:<ref>` inside `references`, `depends_on`, or `parent_node_id` fields supported by OpenReel.
- Use `openreel_move_node` for intentional layout changes. Arrange a readable left-to-right or top-to-bottom flow and avoid moving unrelated nodes.
- Uploading media requires an existing matching image or video node; the upload becomes that node's completed output.

## Models and protocols

- Call `openreel_get_model_config` when model selection or provider capability matters. It returns parsed configuration with secrets masked and never returns raw config text.
- Call `openreel_list_media_protocols` to inspect image, video, or audio protocol capabilities.
- Do not invent provider ids, model ids, image counts, reference limits, durations, or resolutions when these can be read from OpenReel.

## Safety

- Project deletion requires the exact current title after explicit user authorization.
- Node deletion requires explicit user authorization and `confirm=true`.
- Read-only diagnosis does not authorize deletion, project creation, media generation, model spending, or broad canvas rewrites.
- Never expose OpenReel credentials or masked secret values in the response.
