# OSTV — opencode serve to vscode

连接 headless `opencode serve` 的 VS Code 侧边栏聊天面板。AI 工具渲染为卡片，
文件改动通过 VS Code 原生 diff 预览。本质是给 `opencode` CLI 一个更好用的 VS Code 界面。

## 特性（v0.3.1）

- **引导页**：打开插件先看到连接状态（Server 状态 / 版本 / 端口 / 目录），右上角可关闭
- **一键启动**：自动定位 opencode.exe → 探测空闲端口 → 以项目目录启动 serve → 自动更新配置并连接
- **模型管理**：读取服务端全部模型（provider / model），点一下即可启用 / 禁用（禁用的不出现在下拉框）
- **白话 / 专业文案切换**：设置里一键切换通俗中文说明 / 中文+英文术语风格
- **设置面板**：面板内直接改 serverUrl / 账号密码 / 默认模型 / opencode 路径等，无需翻 VS Code 设置
- **会话管理**：历史会话切换、新建、导出（保存为 .txt/.md）
- **流式渲染**：text（迷你 markdown：代码块/粗体/列表/链接）/ reasoning（可折叠，可设置默认展开）/ tool 卡片（输入输出可展开）
- **AI 改动预览**：监听工具事件（edit/write），文件变化后聊天里出现「查看改动」→ VS Code 原生 diff
- **消息复制**：鼠标悬停 AI 消息，一键复制全文
- **自动滚动开关**：输入框旁可关掉自动滚到底
- **中止**：随时停止 AI 回复

## 安装（VSIX）

```powershell
code --install-extension ostv-0.3.1.vsix
```

## 发布（VS Code Marketplace）

```powershell
npx @vscode/vsce login mmmiiiaaoo   # 输入 PAT（dev.azure.com 创建，scopes: Marketplace Manage）
npx @vscode/vsce publish
```

## 开发 / 调试

```bash
npm install
npm run compile      # tsc → out/
```

VS Code 中按 F5 启动扩展开发宿主。

> 注意：`package.json` 不要用 PowerShell 的 `Set-Content -Encoding UTF8` 保存
> （会写入 BOM，导致 `vsce package` 报 "not valid JSON"）。用编辑器或 `npx` 保存。

## 使用

1. 打开一个项目文件夹（AI 的文件操作以它为根目录）
2. 左侧 activity bar → opencode 图标 → Chat 面板
3. 首次进入是引导页：点「一键启动 server」；也可以点右上角 ✕ 直接开始
4. 启动成功（出现一个 serve 黑窗口，**关掉窗口 = 停止服务**）后即可对话
5. 模型：面板 ⚙ → 模型管理，勾选可用的模型；下拉框只显示启用的模型

也可以手动启动 serve：

```powershell
# 在项目目录
opencode serve --port 4096
```

> 注意：Windows 下用 `Start-Process -WindowStyle Hidden` 启动 serve 会卡死
> （监听端口但不响应 HTTP），请用普通窗口启动（扩展的一键启动已正确处理）。

## 配置（设置 → ostv，也可在面板 ⚙ 内改）

| 项 | 默认 | 说明 |
| --- | --- | --- |
| `ostv.serverUrl` | `http://127.0.0.1:4096` | server 地址 |
| `ostv.username` | `opencode` | Basic Auth 用户名 |
| `ostv.password` | 空 | 留空则读 `OPENCODE_SERVER_PASSWORD` |
| `ostv.defaultModel` | 空 | 如 `opencode/big-pickle`（providerID/modelID） |
| `ostv.opencodePath` | 空 | opencode.exe 路径，留空自动探测 |
| `ostv.disabledModels` | `[]` | 禁用的模型列表（模型管理里切换） |
| `ostv.uiLanguage` | `plain` | 界面文案：`plain` 白话 / `pro` 专业 |
| `ostv.showReasoning` | `true` | 默认展开思考过程 |

## 架构

```
src/extension.ts  激活、注册 ChatViewProvider、命令、health + 工作目录比对告警
src/panel.ts      WebviewViewProvider：引导页/一键启动、设置读写、模型管理、SSE 事件分发、文件快照 diff
src/client.ts     HTTP/SSE 客户端（Basic Auth、会话、prompt_async、事件流自动重连）
media/chat.js     webview 端渲染（i18n 文案、消息/工具卡片/流式/diff、markdown）
media/chat.css    VS Code 原生 CSS 变量风格
```

## 已知限制

- server 的 `/session/:id/diff` 与 `session.diff` 事件在 1.18.x 实测返回空，
  diff 采用「工具事件 + 文件快照」方案（AI 改文件前抓快照，完成后对比）
- prompt_async 的 model 字段必须传 `{providerID, modelID}` 对象，传字符串会 400
- `/config/providers` 会返回明文 API key —— 只在本地使用，不要把 server 暴露到公网
- 消息流式文本目前按事件整体渲染，未做词级增量
