# OpenReel Studio for Codex

这是一个可选的外部控制插件。用户在 Codex 会话中明确要求连接 OpenReel 时，Codex 才会直接读取和操作项目、画布节点、依赖线、节点位置、素材上传与节点运行。

插件不会替换或禁用 OpenReel 原有 Agent，也不会改变 OpenReel 聊天区。OpenReel 内嵌的 Codex 聊天连接属于 OpenReel 主程序自身功能，与本插件相互独立。

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

插件直接调用 OpenReel 的原子 REST API 和 `node.*`、`skill.*` 注册工具：

- 项目：列出、新建、读取、更新、确认后删除。
- 画布：读取完整图、创建/更新/移动/连接节点、确认后删除节点。
- 生产：读取制作 skill、读取遮罩模型配置、运行节点并等待真实终态。
- 合同：创建节点前动态读取当前项目、provider、模型协议与模式限制，自动预检并返回字段级修复信息。
- 素材：把本机图片或视频上传为对应节点的产物。

它不暴露 `/api/chat`，也没有“调用 OpenReel Agent”的通用工具；创作判断、步骤安排和失败修复由 Codex 完成。
