# T3 DeepSeek

[![test](https://github.com/aaron-he-zhu/t3-deepseek/actions/workflows/test.yml/badge.svg)](https://github.com/aaron-he-zhu/t3-deepseek/actions/workflows/test.yml)

把 **DeepSeek 官方 API** 一键接进 **T3 Code** 的插件。你只需要粘贴一次 API Key，不需要理解 ACP 是什么。

## 对 agent 说一句就装好（推荐）

对你的任意 coding agent 说：

> 安装 aaron-he-zhu/t3-deepseek

agent 只需执行一条命令：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr 'https://raw.githubusercontent.com/aaron-he-zhu/t3-deepseek/main/bootstrap.ps1' -OutFile $env:TEMP\t3ds-bootstrap.ps1; & $env:TEMP\t3ds-bootstrap.ps1"
```

安装完成后：

1. 重启 T3 Code（重启前不要改任何 T3 设置）
2. 新建线程，模型选择器里选 **T3 DeepSeek**
3. **首次对话会自动弹出 DeepSeek API Key 输入框**，粘贴提交即完成（Key 只保存在本机 `~/.t3-deepseek/config.json`）

## 手动安装

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
```

非交互（一条命令安装，Key 也可不传、留到首次对话弹窗填写）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -ApiKey "sk-xxx" -NonInteractive
```

## 自检 / 卸载

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File verify.ps1   # 配置 + 注册 + 协议测试
powershell -NoProfile -ExecutionPolicy Bypass -File uninstall.ps1
```

## 工作原理

T3 Code 通过 [ACP 协议（Agent Client Protocol v1）](https://agentclientprotocol.com/protocol/v1/overview) 与外部编程代理通信。本插件实现了一个 **本地 ACP agent**：

- `src/acp-server.mjs`：ACP v1 服务端（JSON-RPC 2.0 / NDJSON over stdio），把 T3 的会话、文件读写（`fs/*`）、终端（`terminal/*`）、权限审批（`session/request_permission`）翻译成 DeepSeek 的 `/chat/completions` 调用；模型列表通过 `configOptions`（`category: "model"`）上报给 T3
- **Key 弹窗**：未配置 Key 时，插件通过 ACP `elicitation/create`（form 模式）让 T3 弹出输入框，提交后自动保存——这就是"装完弹提示"的实现
- `src/deepseek-client.mjs`：DeepSeek 官方 API 客户端（流式输出 + function calling），零依赖
- `bin/t3-deepseek.cmd`：启动器。优先用 PATH 里的 node 18+，否则复用 **T3 Code 自带的 Electron 运行时**（`ELECTRON_RUN_AS_NODE`），因此无需安装 Node
- `bootstrap.ps1` / `install.ps1`：注册逻辑——在 `~/.t3/userdata/settings.json` 的 `providerInstances` 里写入 `acp_t3deepseek`（先备份、无 BOM 写入，与 T3 自身行为一致）

## 配置

`~/.t3-deepseek/config.json`：

```json
{
  "version": 1,
  "apiKey": "sk-…",
  "baseUrl": "https://api.deepseek.com",
  "defaultModel": "deepseek-chat",
  "models": [
    { "id": "deepseek-chat", "name": "DeepSeek-V3 (deepseek-chat)", "description": "通用对话与编码模型" },
    { "id": "deepseek-reasoner", "name": "DeepSeek-R1 (deepseek-reasoner)", "description": "深度推理模型" }
  ],
  "maxTokens": { "deepseek-chat": 8192, "deepseek-reasoner": 32768 }
}
```

- `baseUrl` 换成兼容 OpenAI 协议的中转地址即可接入第三方网关
- 环境变量 `T3DEEPSEEK_API_KEY` 优先于配置文件中的 Key

## 测试

```powershell
# 协议级测试（进程内 + mock 后端，不消耗 API 额度）
$env:ELECTRON_RUN_AS_NODE = "1"
& "$env:LOCALAPPDATA\Programs\t3code\T3 Code (Beta).exe" test\harness.mjs
```

## 安全说明

- API Key 只保存在本机 `~/.t3-deepseek/config.json`，不会上传
- `bash` 与 `write_file` 操作会通过 T3 的权限审批询问用户（读取永不审批）
- 安装/卸载都会先备份 `settings.json`，且只增删 `acp_t3deepseek` 这一项

## 目录结构

```
bin/t3-deepseek.cmd       启动器（node 18+ 或 T3 自带 Electron）
src/acp-server.mjs        ACP v1 agent 核心（含 Key 表单弹窗）
src/deepseek-client.mjs   DeepSeek API 客户端
src/prompts.mjs           系统提示词
bootstrap.ps1             一键引导安装（agent/命令行友好）
install.ps1               交互式/非交互安装
uninstall.ps1             卸载
verify.ps1                自检（配置 + 注册 + 协议测试）
test/harness.mjs          协议级测试
```
