# OpenReel Studio for Codex

这是一个可选的外部控制插件。用户在 Codex 会话中明确提出连接或操作 OpenReel 后，Codex 负责分析和编排，插件负责执行项目、画布、节点、依赖线、素材上传与节点运行操作。OpenReel 原有 Agent 和聊天区保持独立可用。

## 快速开始

1. 启动 OpenReel 桌面版或本地服务。
2. 安装插件后新建 Codex 会话并启用 OpenReel Studio 插件。
3. 输入“连接本机 OpenReel，列出项目并查看当前画布”。
4. Codex 连接服务、选择会话、读取画布，并按照请求执行操作。

桌面安装版会在 `127.0.0.1` 上启动 FastAPI 服务，端口从 `7860` 起动态选择。插件扫描本机端口并通过 `/api/health` 的 `app: openreel-studio` 标识确认目标。源码开发版使用同一套自动发现机制。本机服务采用无认证配置时，启动应用即可连接。

## Docker 或远程部署

远程服务第一次连接时，在启动 Codex 前提供服务地址和对应认证信息：

```bash
export OPENREEL_BASE_URL="https://example.com/studio"
export OPENREEL_USERNAME="your-user"
export OPENREEL_PASSWORD="your-password"
```

Bearer token 配置如下：

```bash
export OPENREEL_BASE_URL="https://example.com/studio"
export OPENREEL_TOKEN="your-token"
```

`OPENREEL_BASE_URL` 填写站点根地址或 `/studio` 根地址。健康检查通过后，插件把完整连接配置保存到当前用户的私有配置文件，后续会话直接复用：

- Linux：`~/.config/openreel-codex-plugin/connection.json`
- macOS：`~/Library/Application Support/OpenReel/codex-connection.json`
- Windows：`%APPDATA%\OpenReel\codex-connection.json`

Linux 和 macOS 使用 `0600` 文件权限，Windows 使用当前用户配置目录的访问控制。连接检查只返回配置来源、保存状态和认证类型。显式提供并验证的新连接配置会整体替换原配置，使地址与凭据始终属于同一个服务。

远程无认证服务只需设置 `OPENREEL_BASE_URL`。以下环境变量提供高级控制：

- `OPENREEL_DISCOVERY_PORTS`：本机探测范围，默认 `7860-7920,8000-8020`。
- `OPENREEL_DISCOVERY_TIMEOUT_MS`：单个连接探针超时，默认 15 秒，可配置范围为 1–60 秒。
- `OPENREEL_REQUEST_TIMEOUT_MS`：单次请求超时，默认 20 分钟。
- `OPENREEL_REMEMBER_CONNECTION=0`：本次会话使用显式配置，并跳过持久化。
- `OPENREEL_CONFIG_PATH`：指定受管环境使用的连接配置路径。

清除已保存连接：

```bash
node scripts/openreel-mcp.mjs --forget-connection
```

检查连接：

```bash
node scripts/openreel-mcp.mjs --check
```

## 项目选择

服务器连接和当前项目是两层状态：连接配置跨会话保存，项目选择属于当前 Codex 会话。

1. `openreel_list_projects` 返回会话 ID、名称和 `_codex_selected` 状态。
2. `openreel_select_project` 使用项目 ID 或唯一的完整标题切换目标；同名项目使用 ID。
3. 项目级工具默认操作当前选中项目。
4. `openreel_create_project` 使用会话名称创建项目并自动选中，同时通知已打开的 OpenReel 页面切换到新项目并刷新。
5. `openreel_update_project` 修改会话名称；删除当前项目后选择状态随之清空。

插件选择决定 Codex 的操作目标。OpenReel 浏览器或桌面窗口继续由用户在左侧项目栏控制显示目标。

## 调用流程

每次新 Codex 会话按以下顺序开始：

1. `openreel_connection_info` 发现并验证 OpenReel。
2. `openreel_list_projects` 确认当前目标，必要时使用 `openreel_select_project`。
3. 图级任务读取一次 `openreel_get_canvas`；已知节点任务使用 `openreel_get_nodes` 精确读取。
4. 项目、节点、依赖线和单节点运行使用直接工具。
5. 动态节点合同与复杂低频操作使用 `search → describe → execute`。
6. 完整持久化结果或终态运行结果作为验证；后续步骤依赖新拓扑时再读取画布。

这套流程让连接和项目状态在当前会话内复用，让常见操作保持短调用链，同时按需加载复杂参数 schema。

## 能力分层

直接工具覆盖：

- 连接以及项目列出、选择、创建、读取、重命名和授权删除。
- 画布与节点读取，节点创建、更新、移动和授权删除。
- 依赖线创建、更新和授权删除。
- 单节点运行、服务端终态等待、已有节点媒体上传、Codex 图片发布。
- 延迟能力的搜索、描述、普通执行和授权破坏性执行。

延迟目录提供 6 项复杂或低频能力：节点复制、媒体历史切换、混合画布 patch、批量运行、恢复画布快照、批量删除或恢复。搜索返回短摘要；描述返回精确 `input_schema`、安全类别、执行器名称和 `schema_ref`；执行阶段按 schema 校验参数。动态节点合同已通过 `openreel_describe_node_contract` 直接提供。

混合画布 patch 支持通过 `client_ref` 和 `client:<ref>` 引用同一调用中新建的节点，并按顺序执行。

## 图片生成路径

用户要求 Codex 生成图片且未指定 OpenReel provider 时，默认调用链为：

1. Codex 内置图片生成创建最终本地文件。
2. `openreel_publish_generated_image` 调用通用外部图片导入接口，声明 `generation_backend=codex_builtin`，创建完整图片节点并保存成品。

单张图片对应 1 次图片生成和 1 次插件发布。新版 OpenReel 使用一次导入请求完成节点创建、媒体保存和完整节点事件；兼容路径复用同一个生成文件完成节点上传。用户明确选择 OpenReel 图片模型时，Codex 读取当前动态节点合同，再执行节点创建和运行。详细审计见 [`docs/image-generation-call-analysis.md`](docs/image-generation-call-analysis.md)。

## 视频生成路径

视频统一走 OpenReel 动态节点合同：插件读取 `video` 节点支持的 Provider、模式、
参考素材限制、时长、比例和分辨率，创建节点后调用 `node.run`。插件不拼装服务商
请求、不上传上游素材、不轮询服务商任务，也不解析服务商响应；这些职责由
OpenReel 调用 Universal Model Adapter 完成。

Provider 和字段已经明确时直接调用 `openreel_create_nodes`，桥接层会在创建前完成
动态合同校验；只有 Provider 不明确或创建返回字段错误时才单独调用
`openreel_describe_node_contract`。每个媒体来源只写一次 `fields.references`，不要再
复制到 `reference_images` 或 `depends_on`；`first_frame` 会自动把第一张图片参考映射
为首帧媒体角色。

插件默认通过一个持续的服务端事件请求等待 OpenReel 节点终态，最长 20 分钟；
插件本身不循环读取节点状态。OpenReel 后台通过 UMA 轮询供应商任务，落盘终态后
发布画布事件并结束这一个等待请求。Codex 运行时可以继续等待同一个在途工具调用，
但不需要发起状态查询，也不能自动再次调用运行接口。

等待超时只表示当前等待请求没有等到终态，生成任务可能仍在后台运行；后续调用
`openreel_wait_for_node` 继续等待同一个节点，以免创建重复计费任务。OpenReel API
重启后的上游任务恢复也由 OpenReel 持久化状态并重新接入 UMA 轮询完成。

节点创建、更新、运行和等待结果默认只返回节点身份、状态、任务 ID、媒体 URL 与
错误摘要，不回显完整 prompt、适配器恢复请求、轮询历史或媒体历史。确实需要完整
字段时再显式读取节点，避免大结果反复占用 Codex 上下文。

## 安全边界

- 项目删除需要用户明确授权，并提供与当前标题一致的 `confirm_title`。
- 节点与依赖线删除需要用户明确授权，并设置 `confirm=true`。
- 快照恢复和组合破坏性操作通过破坏性执行器完成。
- 认证信息保存在当前用户私有配置中，工具结果只提供安全元数据。
- 插件通过原子 OpenReel 接口执行操作；OpenReel `/api/chat` 继续服务于独立聊天 Agent。
