import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as net from 'net';
import { OpenCodeClient, Session, Message, Part, ServerEvent } from './client';

interface ViewMessage {
  type: string;
  [key: string]: unknown;
}

interface Status {
  connected: boolean;
  version?: string;
  serverDir?: string;
  wsDir?: string;
  port?: number;
  busy?: boolean;
  error?: string;
}

export class ChatPanel implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private disposables: vscode.Disposable[] = [];
  private client: OpenCodeClient | undefined;
  private currentSessionId: string | undefined;
  private stopEvents: (() => void) | undefined;
  private starting = false;
  private startedChild: import('child_process').ChildProcess | undefined;

  constructor(private context: vscode.ExtensionContext) {}

  async resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    view.webview.html = this.html(view.webview);

    view.webview.onDidReceiveMessage((msg: ViewMessage) => this.onMessage(msg), undefined, this.disposables);

    this.rebuildClient();
    await this.checkStatus();
  }

  private getConfig() {
    const c = vscode.workspace.getConfiguration('opencodeChat');
    return {
      serverUrl: c.get<string>('serverUrl', 'http://127.0.0.1:4096'),
      username: c.get<string>('username', 'opencode'),
      password: c.get<string>('password', ''),
      defaultModel: c.get<string>('defaultModel', ''),
      opencodePath: c.get<string>('opencodePath', ''),
    };
  }

  private rebuildClient() {
    this.stopEvents?.();
    const cfg = this.getConfig();
    const password = cfg.password || process.env.OPENCODE_SERVER_PASSWORD || '';
    this.client = new OpenCodeClient({ serverUrl: cfg.serverUrl, username: cfg.username, password });
  }

  private token(): string {
    const cfg = this.getConfig();
    return cfg.password || process.env.OPENCODE_SERVER_PASSWORD || '';
  }

  private post(type: string, payload: Record<string, unknown> = {}) {
    this.view?.webview.postMessage({ type, ...payload });
  }

  /* ---------------- 状态检测 ---------------- */

  private async checkStatus() {
    const cfg = this.getConfig();
    const wsDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const status: Status = { connected: false, wsDir, busy: this.starting };
    try {
      const client = this.client!;
      const h = await client.health();
      status.connected = h.healthy === true;
      status.version = h.version;
      if (status.connected) {
        try {
          const p = await client.serverPath();
          status.serverDir = p.directory;
          const m = cfg.serverUrl.match(/:(\d+)$/);
          status.port = m ? Number(m[1]) : undefined;
        } catch { /* ignore */ }
      }
    } catch (err) {
      status.error = this.errText(err);
    }
    this.post('status', { ...status });
  }

  /* ---------------- 一键启动 ---------------- */

  private async startServer(): Promise<void> {
    if (this.starting) return;
    this.starting = true;
    try {
      const ws = vscode.workspace.workspaceFolders?.[0];
      if (!ws) {
        vscode.window.showWarningMessage('请先打开一个项目文件夹，再启动 opencode server');
        return;
      }
      const exe = await this.detectOpencode();
      if (!exe) {
        const action = await vscode.window.showErrorMessage(
          '未找到 opencode 可执行文件，请在设置 opencodeChat.opencodePath 中填写 opencode.exe 的完整路径',
          '打开设置',
        );
        if (action === '打开设置') {
          vscode.commands.executeCommand('workbench.action.openSettings', 'opencodeChat.opencodePath');
        }
        return;
      }
      const port = await this.findFreePort();
      const cfg = this.getConfig();
      const password = cfg.password || process.env.OPENCODE_SERVER_PASSWORD || '';

      this.post('server-starting', { port, exe });
      const child = spawn(exe, ['serve', '--port', String(port)], {
        cwd: ws.uri.fsPath,
        windowsHide: false,
        env: {
          ...process.env,
          OPENCODE_SERVER_PASSWORD: password,
          OPENCODE_SERVER_USERNAME: cfg.username,
        },
      });
      this.startedChild = child;
      child.on('error', (err) => {
        this.post('error', { message: `启动失败: ${err.message}` });
      });

      const base = `http://127.0.0.1:${port}`;
      const probe = new OpenCodeClient({ serverUrl: base, username: cfg.username, password });
      let ok = false;
      for (let i = 0; i < 25; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        if (await probe.testConnection()) {
          ok = true;
          break;
        }
        if (child.exitCode !== null) break;
      }
      if (!ok) {
        this.post('error', { message: `serve 启动超时或失败（端口 ${port}），请查看弹出的窗口日志` });
        return;
      }

      await vscode.workspace.getConfiguration('opencodeChat').update('serverUrl', base, vscode.ConfigurationTarget.Global);
      this.rebuildClient();
      await this.subscribeEvents();
      this.post('server-started', { port });
      vscode.window.showInformationMessage(`opencode server 已启动: ${base}（工作目录: ${ws.uri.fsPath}）`);
      await this.pushSessions();
    } finally {
      this.starting = false;
      this.post('status-check-again', {});
    }
  }

  private async detectOpencode(): Promise<string | undefined> {
    const cfgPath = this.getConfig().opencodePath;
    if (cfgPath && cfgPath.trim()) return cfgPath.trim();
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const candidates = [
      home + '\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe',
      home + '\\AppData\\Roaming\\npm\\opencode.cmd',
    ];
    const fs = require('fs');
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    try {
      const { execFile } = require('child_process') as typeof import('child_process');
      const out = await new Promise<string>((resolve, reject) => {
        execFile('where', ['opencode'], { timeout: 5000 }, (e, stdout) => (e ? reject(e) : resolve(stdout)));
      });
      const line = out.split(/\r?\n/).map((s) => s.trim()).find((s) => s && /opencode(\.exe|\.cmd)?$/i.test(s));
      if (line) return line;
    } catch { /* not found in PATH */ }
    return undefined;
  }

  private findFreePort(): Promise<number> {
    return new Promise((resolve) => {
      const tryPort = (p: number) => {
        const srv = net.createServer();
        srv.once('error', () => {
          srv.close();
          tryPort(p + 1);
        });
        srv.listen(p, '127.0.0.1', () => {
          const port = (srv.address() as net.AddressInfo).port;
          srv.close();
          resolve(port);
        });
      };
      tryPort(4096);
    });
  }

  private async pushSessions() {
    const client = this.client!;
    try {
      const sessions = await client.listSessions();
      sessions.sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
      this.post('sessions', { sessions });
      if (!this.currentSessionId && sessions.length > 0) {
        await this.switchSession(sessions[0].id);
      }
    } catch (err) {
      this.post('error', { message: `无法获取会话列表: ${this.errText(err)}` });
    }
  }

  private async switchSession(id: string) {
    this.currentSessionId = id;
    try {
      const messages = await this.client!.messages(id);
      this.post('switch-session', { sessionID: id, messages });
    } catch (err) {
      this.post('error', { message: `加载会话失败: ${this.errText(err)}` });
    }
  }

  private async onMessage(msg: ViewMessage) {
    const client = this.client;
    if (!client) return;
    switch (msg.type) {
      case 'init': {
        this.post('config', {
          serverUrl: this.getConfig().serverUrl,
          defaultModel: this.getConfig().defaultModel,
        });
        try {
          const [agents, providers] = await Promise.all([client.agents(), client.providers()]);
          this.post('options', { agents, providers });
        } catch { /* ignore */ }
        await this.pushSessions();
        break;
      }
      case 'refresh-sessions':
        await this.pushSessions();
        break;
      case 'new-session':
        try {
          const s = await client.createSession();
          this.currentSessionId = s.id;
          this.post('switch-session', { sessionID: s.id, messages: [] });
          await this.pushSessions();
        } catch (err) {
          this.post('error', { message: `新建会话失败: ${this.errText(err)}` });
        }
        break;
      case 'switch-session':
        await this.switchSession(String(msg.sessionID));
        break;
      case 'send': {
        const text = String(msg.text || '').trim();
        if (!text || !this.currentSessionId) return;
        this.post('user-message', { text });
        const model = this.parseModel(msg.model as string | undefined);
        try {
          await client.prompt(this.currentSessionId, text, model);
        } catch (err) {
          this.post('error', { message: `发送失败: ${this.errText(err)}` });
        }
        break;
      }
      case 'abort':
        if (this.currentSessionId) await client.abort(this.currentSessionId);
        break;
      case 'view-diff': {
        const file = String(msg.file || '');
        this.openDiff(file, this.snapshots.get(file) ?? '');
        break;
      }
      case 'status-check':
        await this.checkStatus();
        break;
      case 'start-server':
        await this.startServer();
        break;
    }
  }

  private parseModel(spec?: string): { providerID: string; modelID: string } | undefined {
    if (!spec) {
      const def = this.getConfig().defaultModel;
      spec = def || undefined;
    }
    if (!spec) return undefined;
    const i = spec.indexOf('/');
    if (i <= 0 || i === spec.length - 1) return undefined;
    return { providerID: spec.slice(0, i), modelID: spec.slice(i + 1) };
  }

  /**
   * 打开 VS Code 原生 diff 视图：before（AI 修改前） vs after（当前文件）。
   * 因 /session/:id/diff 实测不可靠，采用工具 input（before 用 git HEAD 或文件回读不可行时，
   * 用 before 参数 = 工具快照），after 直接用磁盘当前内容。
   */
  private async openDiff(relFile: string, before: string) {
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspace) {
      vscode.window.showWarningMessage('未打开工作区，无法打开 diff');
      return;
    }
    const target = vscode.Uri.joinPath(workspace, relFile);
    const afterDoc = await vscode.workspace.openTextDocument(target);
    const afterText = afterDoc.getText();
    const finalBefore = before.length > 0 ? before : afterText;

    const beforeUri = this.tmpUri('before', relFile, finalBefore);
    const title = `opencode: ${relFile} (修改预览)`;
    await vscode.commands.executeCommand(
      'vscode.diff',
      beforeUri,
      afterDoc.uri,
      title,
      { viewColumn: vscode.ViewColumn.Beside, preview: true },
    );
  }

  private tmpUri(label: string, relFile: string, content: string): vscode.Uri {
    const fsPath = require('path').join(this.context.extensionUri.fsPath, 'out', label.replace(/[^a-z0-9]/gi, '_') + '.txt');
    try {
      require('fs').writeFileSync(fsPath, content, 'utf8');
    } catch { /* ignore */ }
    return vscode.Uri.file(fsPath);
  }

  private subscribeEvents() {
    this.stopEvents?.();
    const client = this.client!;
    this.stopEvents = client.subscribeEvents(
      (ev) => this.onServerEvent(ev),
      () => this.post('error', { message: '事件流断开' }),
    );
  }

  private onServerEvent(ev: ServerEvent) {
    switch (ev.type) {
      case 'message.update': {
        const info = ev.properties?.info as any;
        if (info?.role === 'assistant') {
          this.post('assistant-message', { messageID: info.id });
        }
        break;
      }
      case 'message.part.updated': {
        const props = (ev.properties || {}) as any;
        const part = props.part as Part;
        if (!part) break;
        const messageID = String(props.messageID || '');
        if (part.type === 'tool' && part.tool && (part.state?.status === 'running' || part.state?.status === 'completed')) {
          this.handleAiFile(part).catch(() => { /* ignore */ });
        }
        this.post('part-updated', { part, messageID });
        break;
      }
      case 'session.idle':
        this.post('idle', {});
        break;
      case 'session.error': {
        const props = ev.properties as any;
        this.post('error', { message: String(props?.error ?? '会话错误') });
        break;
      }
      default:
        break;
    }
  }

  private snapshots = new Map<string, string>();

  /**
   * AI 改文件快照方案（替代不可靠的 /session/:id/diff）：
   * - running：文件被改前，磁盘内容存为快照（before）
   * - completed：重读磁盘 = after，推送 ai-changed-file。同一文件二次修改时 before=上次 after。
   */
  private async handleAiFile(part: Part) {
    if (part.tool !== 'edit' && part.tool !== 'write') return;
    const input = (part.state?.input || {}) as any;
    if (!input || typeof input !== 'object') return;
    const rawFile = String(input.filePath || input.file || '');
    if (!rawFile) return;
    const base = rawFile.split(/[\\/]/).pop() || '';
    if (!base) return;

    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) return;

    const find = await this.findWorkspaceFile(base);
    if (!find) return;
    const { uri, rel } = find;
    const doc = await vscode.workspace.openTextDocument(uri);
    const cur = doc.getText();

    if (part.state?.status === 'running' && !this.snapshots.has(rel)) {
      this.snapshots.set(rel, cur);
      return;
    }
    if (part.state?.status === 'completed') {
      const before = this.snapshots.get(rel);
      this.snapshots.set(rel, cur);
      this.post('ai-changed-file', { file: rel, before: before ?? '' });
    }
  }

  private async findWorkspaceFile(base: string): Promise<{ uri: vscode.Uri; rel: string } | undefined> {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) return undefined;
    const direct = vscode.Uri.joinPath(ws.uri, base);
    try {
      await vscode.workspace.fs.stat(direct);
      return { uri: direct, rel: base };
    } catch { /* not in root */ }
    const found = await vscode.workspace.findFiles(`**/${base}`, '**/node_modules/**', 3);
    for (const uri of found) {
      try {
        await vscode.workspace.fs.stat(uri);
        const rel = vscode.workspace.asRelativePath(uri, false);
        return { uri, rel };
      } catch { /* ignore */ }
    }
    return undefined;
  }

  createSessionFromCommand() {
    this.onMessage({ type: 'new-session' });
  }

  startServerFromCommand() {
    this.onMessage({ type: 'start-server' });
  }

  checkStatusFromCommand() {
    this.onMessage({ type: 'status-check' });
  }

  private errText(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
  }

  private html(webview: vscode.Webview): string {
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chat.js'));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chat.css'));
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' ${webview.cspSource}; style-src 'unsafe-inline' ${webview.cspSource}; img-src ${webview.cspSource} data:;">
  <link rel="stylesheet" href="${css}">
</head>
<body>
  <div id="welcome">
    <div class="welcome-inner">
      <h2>opencode chat</h2>
      <p class="welcome-sub">连接 headless opencode server，在 VS Code 里和 AI 协作</p>
      <div id="status-card" class="status-card">
        <div class="status-row"><span>Server 状态</span><span id="st-conn" class="st-value">检测中…</span></div>
        <div class="status-row"><span>版本</span><span id="st-version" class="st-value">-</span></div>
        <div class="status-row"><span>端口</span><span id="st-port" class="st-value">-</span></div>
        <div class="status-row"><span>Server 目录</span><span id="st-srvdir" class="st-value">-</span></div>
        <div class="status-row"><span>工作区</span><span id="st-wsdir" class="st-value">-</span></div>
      </div>
      <div id="status-error" class="status-error" hidden></div>
      <div class="welcome-actions">
        <button id="btn-start-server" class="primary">一键启动 server</button>
        <button id="btn-check-status">重新检测</button>
      </div>
      <div id="start-progress" class="start-progress" hidden>正在启动 serve…（首次启动需要几秒）</div>
      <div class="welcome-help">
        <details>
          <summary>使用说明</summary>
          <ul>
            <li>先打开一个项目文件夹（AI 的文件操作以它为根目录）</li>
            <li>点击「一键启动 server」：自动找到 opencode.exe、自动选择空闲端口并启动</li>
            <li>启动后会出现一个黑窗口（serve 本体），<b>关掉窗口 = 停止服务</b></li>
            <li>手动启动方式：<code>opencode serve --port 4096</code>（在项目目录）</li>
            <li>连接与鉴权配置在设置里：<code>opencodeChat.serverUrl / username / password / opencodePath</code></li>
          </ul>
        </details>
      </div>
    </div>
  </div>
  <div id="chat-app" hidden>
    <div id="toolbar">
      <select id="session-select" title="会话"></select>
      <button id="btn-new" title="新建会话">+</button>
    </div>
    <div id="chat"></div>
    <div id="composer-wrap">
      <select id="model-select" title="模型"></select>
      <textarea id="input" rows="2" placeholder="输入消息，Enter 发送，Shift+Enter 换行"></textarea>
      <div id="composer-actions">
        <button id="btn-send">发送</button>
        <button id="btn-abort" class="danger" hidden>停止</button>
      </div>
    </div>
  </div>
  <script src="${js}"></script>
</body>
</html>`;
  }

  dispose() {
    this.stopEvents?.();
    this.disposables.forEach((d) => d.dispose());
  }
}