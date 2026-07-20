# OpenReel Codex Plugin

让 Codex 直接连接并操作正在运行的 [OpenReel Studio](https://github.com/yutianxiao6/openreel-studio)：项目、节点和依赖线 CRUD 直接可用，复杂或低频画布能力再通过 `search → describe → execute` 按需加载。

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

桌面版和本地源码版会通过受验证的本机端口自动发现。Docker 或远程部署首次连接时设置地址及可选认证；验证成功后会保存到当前用户的私有配置文件，后续新会话无需重复输入。完整路径、安全边界和清除方式见 [插件文档](plugins/openreel-studio/README.md)。

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
