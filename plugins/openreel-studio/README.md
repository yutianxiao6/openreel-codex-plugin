# OpenReel Studio for Codex

这是一个可选的外部控制插件。用户在 Codex 会话中明确要求连接 OpenReel 时，Codex 才会直接读取和操作项目、画布节点、依赖线、节点位置、素材上传与节点运行。

插件不会替换或禁用 OpenReel 原有 Agent，也不会改变 OpenReel 聊天区。OpenReel 主程序不内嵌 Codex；Codex 只通过本插件建立可选的外部控制连接。

## 安装版如何连接

OpenReel 桌面安装版启动时，会在 `127.0.0.1` 上启动仅本机可访问的 FastAPI 服务，端口从 `7860` 起动态选择。插件会扫描安装版端口范围，并且只有在 `/api/health` 返回 `app: openreel-studio` 后才建立连接，因此不依赖网页地址、Electron 窗口对象或固定端口。

本机服务未启用认证时，不需要设置用户名、密码或 token。

使用时只需：

1. 启动 OpenReel 桌面版并保持运行。
2. 安装插件后，新建 Codex 会话并启用 OpenReel Studio 插件。
3. 让 Codex“连接本机 OpenReel，列出项目并查看画布”。

源码开发版默认端口范围也会自动探测。

## Docker 或远程部署

远程目标不会自动探测。第一次连接时，在启动 Codex 前显式设置：

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

第一次连接通过健康检查后，插件会把地址与认证信息保存到当前用户的私有配置文件。以后新开 Codex 会话会直接读取该文件，无需再次设置地址、用户名、密码或 token：

- Linux：`~/.config/openreel-codex-plugin/connection.json`
- macOS：`~/Library/Application Support/OpenReel/codex-connection.json`
- Windows：`%APPDATA%\OpenReel\codex-connection.json`

Linux 和 macOS 上配置文件权限固定为 `0600`，仅当前用户可读写；Windows 使用当前用户配置目录的访问控制。账号密码或 token 会保存在这个本机文件中，但绝不会出现在连接检查结果中。请只在受信任的个人账户和设备上启用记忆。

环境变量只承担首次配置和临时覆盖，不是长期存储位置。显式配置一套新地址或认证信息并连接成功后，会整体替换旧配置，避免把旧站点凭据发送到新站点。未启用认证的远程服务只设置地址即可。

如需忘记已保存连接，在插件目录运行：

```bash
node scripts/openreel-mcp.mjs --forget-connection
```

高级选项：

- `OPENREEL_DISCOVERY_PORTS`：本机探测范围，默认 `7860-7920,8000-8020`。
- `OPENREEL_REQUEST_TIMEOUT_MS`：单次 OpenReel 请求超时，默认 20 分钟。
- `OPENREEL_REMEMBER_CONNECTION=0`：仅本次使用环境变量，不写入连接配置。
- `OPENREEL_CONFIG_PATH`：覆盖连接配置文件位置，主要用于受管环境和测试。

## 本地检查

```bash
node scripts/openreel-mcp.mjs --check
node --test tests/openreel-mcp.test.mjs
```

返回的连接信息只说明配置来源、是否已保存和认证类型，不会包含密码或 token。能力搜索只返回短摘要，只有描述阶段才返回所选能力的参数 schema。

## 项目选择与切换

连接服务器和选择项目是两层独立状态。服务器地址与认证可以长期保存；当前项目只绑定到本次 Codex 会话，不写入连接配置，也不会被下一个 Codex 会话继承。

1. 用 `openreel_list_projects` 列出项目，返回项中的 `_codex_selected=true` 表示本会话当前项目。
2. 用 `openreel_select_project` 按项目 ID 或唯一的完整标题切换。同名项目必须使用 ID，插件不会猜测。
3. 选择后，节点、依赖线、运行和项目修改工具可以省略 `project_id`，自动使用当前项目。
4. 如果工具显式传入另一个项目 ID，插件会在请求 OpenReel 前拒绝操作，必须先显式切换。
5. `openreel_create_project` 只填写会话名字，创建成功后会自动切换到新会话；`openreel_update_project` 只负责重命名，删除当前会话后会清空选择。
6. 会话列表、读取和切换只向 Codex 返回会话 ID 与名字；旧项目的画幅、集数、时长和预算字段仅留在 OpenReel 内部兼容历史数据。

这里切换的是 Codex 插件的操作目标。插件通过服务端 API 操作项目，不会强制改变某个已打开浏览器窗口当前显示的页面；用户可以在 OpenReel 左侧项目栏看到并切换到同一项目。

## 能力边界

插件采用“基础操作直接加载，复杂操作延迟发现”的分层。Codex 初始可直接使用：

- 连接与项目：连接，列出、选择、切换、创建、读取、更新和确认后删除项目。
- 节点基础操作：读取画布/节点，创建、更新、移动和确认后删除节点。
- 依赖线基础操作：创建、更新和确认后删除依赖线。
- 常用执行：运行单个节点、向已有节点上传本地图片或视频。
- Codex 原生出图：默认先调用 Codex 内置图片生成，再用 `openreel_publish_generated_image` 一步创建完整图片节点并显示到画布；用户明确指定 OpenReel 模型时才走节点创建与运行。
- 延迟发现入口：搜索、描述、执行普通能力、执行经确认的破坏性能力。

项目、节点和依赖线 CRUD 不需要先搜索。其中项目删除要求 `confirm_title` 与当前项目标题完全一致；节点和依赖线删除要求明确授权及 `confirm=true`。

延迟目录只保留 8 项复杂或低频能力：动态节点合同、节点复制、媒体历史切换、混合画布 patch、批量运行、等待终态、恢复画布快照、批量删除/恢复。它们使用 `search → describe → execute`：搜索只返回短摘要，描述才返回精确 `input_schema` 和带 schema 哈希的 `schema_ref`，执行前服务端再次校验参数。

其中批量画布 patch 支持通过 `client_ref` 和 `client:<ref>` 引用同一次调用中新建的节点，并在第一项失败时停止。

创作流程、提示词方法和工作习惯由 Codex 自己的 skill 管理。插件不读取或暴露 OpenReel 内置 skill，只提供画布状态、动态节点合同和原子执行能力。

单张图片的推荐调用链只有两次宿主工具调用：一次 Codex 内置图片生成、一次 `openreel_publish_generated_image`。新版 OpenReel 对后者只接收一次导入请求并广播一次完整节点事件；旧版服务自动回退到创建节点再上传，不会改用 OpenReel 图片模型。详细调用审计见 [`docs/image-generation-call-analysis.md`](docs/image-generation-call-analysis.md)。

它不暴露 `/api/chat`，也没有“调用 OpenReel Agent”的通用工具；创作判断、步骤安排和失败修复由 Codex 完成。
