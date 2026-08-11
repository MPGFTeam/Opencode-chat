# opencode chat

连接 headless `opencode serve` 的 VS Code 侧边栏聊天面板。AI 工具渲染为卡片，
文件改动通过 VS Code 原生 diff 预览。本质是给 `opencode` CLI 一个更好用的 VS Code 界面。

## 特性

- **一键启动**：打开插件先看到引导页（连接状态 / 端口 / 目录），
  点「一键启动 server」自动完成：定位 opencode.exe → 探测空闲端口 → 以当前项目目录启动 serve → 自动更新配置并连接
- **会话管理**：历史会话下拉切换、新建会话
- **流式渲染**：text / reasoning（折叠）/ tool 卡片（输入输出可展开）/ step 分隔
- **AI 改动预览**：监听工具事件（edit/write），文件变化后聊天里出现「查看改动」→ VS Code 原生 diff
- **模型选择**：下拉选择 provider/model（默认 = server 默认模型）
- **中止**：随时停止 AI 回复

## 安装（VSIX）

```powershell
code --install-extension opencode-chat-0.2.0.vsix
```

## 开发 / 调试

```bash
npm install
npm run compile      # tsc → out/
```

VS Code 中按 F5 启动扩展开发宿主。

## 使用

1. 打开一个项目文件夹（AI 的文件操作以它为根目录）
2. 左侧 activity bar → opencode 图标 → Chat 面板
3. 首次进入是引导页：点「一键启动 server」
4. 启动成功（出现一个 serve 黑窗口，**关掉窗口 = 停止服务**）后即可对话

也可以手动启动 serve：

```powershell
# 在项目目录
opencode serve --port 4096
```

> 注意：Windows 下用 `Start-Process -WindowStyle Hidden` 启动 serve 会卡死
> （监听端口但不响应 HTTP），请用普通窗口启动（扩展的一键启动已正确处理）。

## 配置（设置 → opencodeChat）

| 项 | 默认 | 说明 |
| --- | --- | --- |
| `opencodeChat.serverUrl` | `http://127.0.0.1:4096` | server 地址 |
| `opencodeChat.username` | `opencode` | Basic Auth 用户名 |
| `opencodeChat.password` | 空 | 留空则读 `OPENCODE_SERVER_PASSWORD` |
| `opencodeChat.defaultModel` | 空 | 如 `opencode/big-pickle`（providerID/modelID） |
| `opencodeChat.opencodePath` | 空 | opencode.exe 路径，留空自动探测 |

## 架构

```
src/extension.ts  激活、注册 ChatViewProvider、命令、health + 工作目录比对告警
src/panel.ts      WebviewViewProvider：引导页/一键启动、postMessage 协议、SSE 事件分发、文件快照 diff
src/client.ts     HTTP/SSE 客户端（Basic Auth、会话、prompt_async、事件流自动重连）
media/chat.js     webview 端渲染（引导页/消息/工具卡片/流式/diff 按钮）
media/chat.css    VS Code 原生 CSS 变量风格
```

## 已知限制

- server 的 `/session/:id/diff` 与 `session.diff` 事件在 1.18.x 实测返回空，
  diff 采用「工具事件 + 文件快照」方案（AI 改文件前抓快照，完成后对比）
- prompt_async 的 model 字段必须传 `{providerID, modelID}` 对象，传字符串会 400
- 消息流式文本目前按事件整体渲染，未做词级增量
