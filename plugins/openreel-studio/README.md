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

返回的连接信息不会包含密码或 token。模型配置读取也只返回遮罩后的结构化配置，不会返回原始配置文件文本。

## 能力边界

插件只向 Codex 公开 8 个 MCP 工具，避免把二十多个细粒度 schema 一次性塞进模型上下文：

- `openreel_connection_info`：发现并验证安装版、源码版或远程 API。
- `openreel_list_projects`：列出可操作项目。
- `openreel_get_canvas`：一次读取完整节点、位置、媒体历史和依赖线。
- `openreel_describe_node_contract`：动态读取当前 provider、模型协议、模式限制和字段级修复信息。
- `openreel_apply_canvas_patch`：按顺序创建、复制、更新、移动节点，创建/改名依赖线，以及切换媒体历史。
- `openreel_delete_canvas_items`：经明确确认后删除节点/依赖线，或恢复已知画布快照。
- `openreel_run_nodes`：预检并顺序运行一个或多个节点，等待真实终态。
- `openreel_upload_node_media`：把本机图片或视频上传为已有节点的完成产物。

`openreel_apply_canvas_patch` 使用带 `op` 的结构化操作数组，不是自由文本命令。一次调用可完成整组画布编辑，并在第一项失败时停止；`create_node` 可声明 `client_ref`，后续操作用 `client:<ref>` 精确引用刚创建的节点。细粒度 REST 和 `node.*` 调用只留在桥接器内部实现，不会出现在 Codex 的 `tools/list` 中。

创作流程、提示词方法和工作习惯由 Codex 自己的 skill 管理。插件不读取或暴露 OpenReel 内置 skill，只提供画布状态、动态节点合同和原子执行能力。

它不暴露 `/api/chat`，也没有“调用 OpenReel Agent”的通用工具；创作判断、步骤安排和失败修复由 Codex 完成。
