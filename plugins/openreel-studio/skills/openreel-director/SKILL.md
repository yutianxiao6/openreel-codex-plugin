---
name: openreel-director
description: Let Codex directly operate a running OpenReel Studio installation, including projects, canvas nodes, dependencies, media uploads, model-aware node authoring, and node runs. Use when the user asks Codex to inspect, build, edit, troubleshoot, or run work inside OpenReel instead of delegating to OpenReel's own chat agent.
---

# OpenReel Direct Director

This is an opt-in control mode. Installing the plugin does not replace OpenReel's default chat agent. Use it only when the user explicitly asks Codex to connect to or operate OpenReel; then Codex is the reasoning and orchestration agent for that requested work. Common project and canvas primitives load directly; complex or uncommon capabilities are discovered on demand.

## Connection

1. Call `openreel_connection_info` before the first OpenReel operation in a thread.
2. Do not connect, inspect projects, or change the OpenReel chat mode merely because the plugin is installed. Activation is a user choice.
3. Installed desktop builds start a verified loopback API on a dynamic port. The bridge discovers it automatically; the user only needs to start OpenReel.
4. Source builds are discovered on their normal local ports.
5. Docker and remote deployments use the saved user connection configuration. On the first verified connection, documented environment variables provide the address and optional Basic or bearer authentication; the bridge saves them privately for later sessions.
6. A complete explicit connection profile replaces the saved profile only after verification, so credentials from one server are never inherited by a newly specified server.
7. If discovery fails, tell the user to start the installed app. Ask for first-time remote configuration only when the intended target is not local and no saved configuration is available.

## Direct-control boundary

- Use the `openreel_*` MCP tools. They call OpenReel project endpoints and atomic registry tools directly.
- Do not call `/api/chat`, send slash commands, or ask OpenReel's Agent Loop to decide or execute the work.
- Production methods and prompt-writing knowledge come from Codex skills. The bridge does not expose OpenReel's internal skills. Running `node.run` invokes the node's configured model/provider, not the OpenReel chat agent.
- Keep Codex's own plan and reasoning in the Codex conversation. Persist user-visible creative truth as OpenReel `text`, `image`, `video`, or `audio` nodes.

## Operating sequence

1. Connect, then call `openreel_list_projects` and select the exact project id. Project create/get/update/delete tools are directly available; delete only with an exact title after explicit authorization.
2. Read `openreel_get_canvas` before changing an existing canvas. It returns the persisted nodes, their fields and positions, media history, and edges in one graph snapshot.
3. Use the applicable Codex skill for production method and prompt guidance. OpenReel contributes runtime state and model contracts, not an additional skill layer.
4. Use the directly loaded node tools for read/create/update/move/delete, the edge tools for connect/update/delete, `openreel_run_node` for a single run, and `openreel_upload_node_media` for local media.
5. For an operation that has no direct tool, call `openreel_search_capabilities`. Search results are summaries only and intentionally omit parameter schemas.
6. Call `openreel_describe_capability` for the selected uncommon capability, then call its returned executor with the exact `schema_ref` and schema-matching `arguments`.
7. Read the changed node or canvas state and verify the persisted result. A provider accepting a job is not proof that media generation completed.

Search again when the uncommon operation changes. Do not route ordinary CRUD through the deferred executor, guess a capability id, or reuse another capability's schema.

## Canvas handling

- Treat ids returned by OpenReel as authoritative. Visible ids such as `#3` are accepted by the bridge and resolved before raw canvas operations.
- Preserve existing nodes and user-authored material. Read before update and patch only relevant fields.
- Use direct node and edge tools for normal CRUD. Search for the ordered canvas patch capability only when one change needs several dependent operation types.
- Arrange a readable flow and avoid moving unrelated nodes.
- Node duplication is deferred because it deliberately copies creative state while excluding generated output history.
- Uploading media requires an existing matching image or video node; the upload becomes that node's completed output.

## Models and protocols

- Search for and describe the dynamic node-contract capability before creating an unfamiliar media node. Treat its result as the authoritative merged view for the current project, provider, model profile, video mode, and candidate fields. Do not bypass a `ready=false` result.
- For image nodes, use both `aspect_ratio` and the exact matching resolution returned or accepted by the current contract; do not assume a hardcoded size.
- Do not invent provider ids, model ids, image counts, reference limits, durations, or resolutions when these can be read from OpenReel.

## Safety

- Project deletion requires the exact current title after explicit user authorization.
- Direct node and edge deletion require explicit user authorization and their `confirm=true` fields.
- Deferred snapshot recovery or combined destructive batches require explicit authorization and `openreel_execute_destructive_capability(confirm=true)`.
- Read-only diagnosis does not authorize deletion, media generation, model spending, or broad canvas rewrites.
- Never expose OpenReel credentials or masked secret values in the response.
- Never read or reproduce the saved connection file. Use `openreel_connection_info` for its safe source, saved-state, and authentication metadata.
