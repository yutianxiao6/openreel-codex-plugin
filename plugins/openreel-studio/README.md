# OpenReel Studio for Codex

这是一个可选的外部控制插件。用户在 Codex 会话中明确要求连接 OpenReel 时，Codex 才会直接读取和操作项目、画布节点、依赖线、节点位置、素材上传与节点运行。

插件不会替换或禁用 OpenReel 原有 Agent，也不会改变 OpenReel 聊天区。OpenReel 主程序不内嵌 Codex；Codex 只通过本插件建立可选的外部控制连接。

## 安装版如何连接

OpenReel 桌面安装版启动时，会在 `127.0.0.1` 上启动仅本机可访问的 FastAPI 服务，端口从 `7860` 起动态选择。插件会扫描安装版端口范围，并且只有在 `/api/health` 返回 `app: openreel-studio` 后才建立连接，因此不依赖网页地址、Electron 窗口对象或固定端口。

使用时只需：

1. 启动 OpenReel 桌面版并保持运行。
2. 安装插件后，新建 Codex 会话并启用 OpenReel Studio 插件。
3. 让 Codex“连接本机 OpenReel，列出项目并查看画布”。

源码开发版默认端口范围也会自动探测。

## Docker 或远程部署

远程目标不会自动探测，启动 Codex 前显式设置：

```bash
export OPENREEL_BASE_URL="https://example.com/studio"
export OPENREEL_USERNAME="your-user"
export OPENREEL_PASSWORD="your-password"
```

也可以使用 bearer token：

```bash
export OPENREEL_BASE_URL="https://example.com/studio"
export OPENREEL_TOKEN="your-token"
```

`OPENREEL_BASE_URL` 是站点根或 `/studio` 根，不要带 `/api`。插件不会默认连接任何公网 OpenReel 站点。

高级选项：

- `OPENREEL_DISCOVERY_PORTS`：本机探测范围，默认 `7860-7920,8000-8020`。
- `OPENREEL_REQUEST_TIMEOUT_MS`：单次 OpenReel 请求超时，默认 20 分钟。

## 本地检查

```bash
node scripts/openreel-mcp.mjs --check
node --test tests/openreel-mcp.test.mjs
```

返回的连接信息不会包含密码或 token。能力搜索只返回短摘要，只有描述阶段才返回所选能力的参数 schema。

## 能力边界

插件只向 Codex 公开 7 个 MCP 工具，具体画布操作保存在服务端 capability 目录中，不会把二十多个参数 schema 一次性塞进模型上下文：

- `openreel_connection_info`：发现并验证安装版、源码版或远程 API。
- `openreel_list_projects`：列出可操作项目。
- `openreel_get_canvas`：一次读取完整节点、位置、媒体历史和依赖线。
- `openreel_search_capabilities`：按意图搜索节点、依赖线、运行、上传、历史与恢复能力，只返回短摘要。
- `openreel_describe_capability`：按需加载一个能力的精确 schema、使用边界、执行入口与 `schema_ref`。
- `openreel_execute_capability`：校验 `schema_ref` 和参数后执行普通能力。
- `openreel_execute_destructive_capability`：经明确确认后执行删除或快照恢复能力。

标准链路是 `search → describe → execute`。搜索结果不携带 schema；描述结果才返回当前能力的精确 `input_schema`。执行必须携带描述阶段返回的 `schema_ref`，后端会再次做 JSON Schema 校验，参数错误时不会请求 OpenReel。创建、复制、更新、移动、连线、历史切换、运行、等待、上传、删除和快照恢复等细粒度能力都可被搜索发现，但不会出现在初始 `tools/list` 中。

需要一次完成多项依赖编辑时，可以搜索“批量画布 patch”。其延迟 schema 使用带 `op` 的结构化数组，支持通过 `client_ref` 和 `client:<ref>` 引用同一次调用中新建的节点，并在第一项失败时停止。

创作流程、提示词方法和工作习惯由 Codex 自己的 skill 管理。插件不读取或暴露 OpenReel 内置 skill，只提供画布状态、动态节点合同和原子执行能力。

它不暴露 `/api/chat`，也没有“调用 OpenReel Agent”的通用工具；创作判断、步骤安排和失败修复由 Codex 完成。
