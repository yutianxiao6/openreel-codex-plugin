# OpenReel Codex Plugin

让 Codex 直接连接并操作正在运行的 [OpenReel Studio](https://github.com/yutianxiao6/openreel-studio)：读取项目和画布、按当前模型协议预检节点参数、批量修改画布、上传素材并运行节点。插件只公开 7 个发现/执行工具，具体画布能力通过 `search → describe → execute` 按需加载。

这个仓库承载唯一的“Codex → OpenReel”连接方式。OpenReel 主程序不内嵌 Codex，也不会启动 Codex 后台进程；安装本插件后，用户仍需在 Codex 中明确要求连接和操作 OpenReel。

## 安装

先把本仓库添加为 Codex marketplace，再安装插件：

```bash
codex plugin marketplace add https://github.com/yutianxiao6/openreel-codex-plugin.git
codex plugin add openreel-studio@openreel-codex
```

安装或更新后，请新建一个 Codex 会话，让插件工具和 skill 完整加载。

## 使用

启动 OpenReel Studio，然后在 Codex 中明确要求连接，例如：

> 连接本机 OpenReel，列出项目并概览当前画布。

桌面版和本地源码版会通过受验证的本机端口自动发现。Docker 或远程部署需设置 `OPENREEL_BASE_URL`，认证方式和完整能力说明见 [插件文档](plugins/openreel-studio/README.md)。

## 仓库结构

```text
.agents/plugins/marketplace.json       Codex marketplace 清单
plugins/openreel-studio/               Codex 插件本体
  .codex-plugin/plugin.json            插件清单
  .mcp.json                            MCP 服务入口
  scripts/openreel-mcp.mjs             OpenReel 控制桥
  skills/openreel-director/SKILL.md    Codex 操作规范
```

OpenReel 主仓以 Git submodule 引用本仓库，插件仍可单独安装、发布和维护。

## 本地验证

```bash
node --check plugins/openreel-studio/scripts/openreel-mcp.mjs
node plugins/openreel-studio/scripts/openreel-mcp.mjs --check
```

## License

MIT
