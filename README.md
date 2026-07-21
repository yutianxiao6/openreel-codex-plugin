# OpenReel Codex Plugin

让 Codex 直接连接并操作正在运行的 [OpenReel Studio](https://github.com/yutianxiao6/openreel-studio)：项目、节点和依赖线 CRUD 使用直接工具，复杂或低频画布能力通过 `search → describe → execute` 按需加载。

这个仓库承载“Codex → OpenReel”外部控制连接。用户在 Codex 中明确提出连接或操作请求后，Codex 负责分析和编排，插件负责执行 OpenReel 原子操作；OpenReel 主程序和内置 Agent 保持独立运行。

## 安装

先把本仓库添加为 Codex marketplace，再安装插件：

```bash
codex plugin marketplace add https://github.com/yutianxiao6/openreel-codex-plugin.git
codex plugin add openreel-studio@openreel-codex
```

安装或更新后，新建一个 Codex 会话即可加载最新版工具和 Skill。

## 使用

启动 OpenReel Studio，然后在 Codex 中明确要求连接，例如：

> 连接本机 OpenReel，列出项目，切换到“产品演示”，然后概览画布。

桌面版和本地源码版通过受验证的本机端口自动发现。Docker 或远程部署首次连接时设置地址及可选认证；验证成功后保存到当前用户的私有配置文件，后续新会话直接复用。项目可以在同一 Codex 会话中显式切换，新建项目会自动成为当前操作目标。完整调用流程、安全边界和项目选择规则见 [插件文档](plugins/openreel-studio/README.md)。

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
node --test plugins/openreel-studio/tests/*.test.mjs
node plugins/openreel-studio/scripts/openreel-mcp.mjs --check
```

## License

MIT
