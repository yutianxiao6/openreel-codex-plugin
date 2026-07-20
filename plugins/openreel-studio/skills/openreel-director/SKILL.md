---
name: openreel-director
description: Let Codex directly operate a running OpenReel Studio installation, including projects, canvas nodes, dependencies, media uploads, model-aware node authoring, and node runs. Use when the user asks Codex to inspect, build, edit, troubleshoot, or run work inside OpenReel instead of delegating to OpenReel's own chat agent.
---

# OpenReel Direct Director

This is an opt-in control mode. Installing the plugin does not replace OpenReel's default chat agent. Use it only when the user explicitly asks Codex to connect to or operate OpenReel; then Codex is the reasoning and orchestration agent for that requested work. The bridge exposes a small discovery surface; exact canvas operation schemas are loaded only when needed.

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

## Deferred capability sequence

1. Connect, then call `openreel_list_projects` and select the exact project id.
2. Read `openreel_get_canvas` before changing an existing canvas. It returns the persisted nodes, their fields and positions, media history, and edges in one graph snapshot.
3. Use the applicable Codex skill for production method and prompt guidance. OpenReel contributes runtime state and model contracts, not an additional skill layer.
4. Call `openreel_search_capabilities` with the concrete operation intent. Search results are summaries only and intentionally omit parameter schemas.
5. Call `openreel_describe_capability` for the selected capability. Read its exact `input_schema`, `usage`, `destructive`, `executor`, and `schema_ref`.
6. Call the returned executor with the same capability id and `schema_ref`. Put only fields accepted by `input_schema` in `arguments`; the server rejects stale schema refs and invalid fields before calling OpenReel.
7. Read the changed node or canvas state and verify the persisted result. A provider accepting a job is not proof that media generation completed.

Search again when the needed operation changes. Do not guess a capability id or reuse a schema from another capability.

## Canvas handling

- Treat ids returned by OpenReel as authoritative. Visible ids such as `#3` are accepted by the bridge and resolved before raw canvas operations.
- Preserve existing nodes and user-authored material. Read before update and patch only relevant fields.
- Search for the ordered canvas patch capability when one change needs several dependent operations. Its deferred schema documents patch-local `client_ref` values.
- Arrange a readable flow and avoid moving unrelated nodes.
- Use the discovered duplication capability for editable alternatives; it deliberately excludes generated output history.
- Uploading media requires an existing matching image or video node; the upload becomes that node's completed output.

## Models and protocols

- Search for and describe the dynamic node-contract capability before creating an unfamiliar media node. Treat its result as the authoritative merged view for the current project, provider, model profile, video mode, and candidate fields. Do not bypass a `ready=false` result.
- For image nodes, use both `aspect_ratio` and the exact matching resolution returned or accepted by the current contract; do not assume a hardcoded size.
- Do not invent provider ids, model ids, image counts, reference limits, durations, or resolutions when these can be read from OpenReel.

## Safety

- Capabilities marked `destructive=true` require explicit user authorization and `openreel_execute_destructive_capability(confirm=true)`.
- Read-only diagnosis does not authorize deletion, media generation, model spending, or broad canvas rewrites.
- Never expose OpenReel credentials or masked secret values in the response.
