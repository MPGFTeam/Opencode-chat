import * as vscode from 'vscode';
import { ChatPanel } from './panel';
import { OpenCodeClient } from './client';

export function activate(context: vscode.ExtensionContext) {
  const panel = new ChatPanel(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('ostv.chat', panel),
    vscode.commands.registerCommand('ostv.focus', () => {
      vscode.commands.executeCommand('ostv.chat.focus');
    }),
    vscode.commands.registerCommand('ostv.newSession', () => {
      vscode.commands.executeCommand('ostv.chat.focus');
      panel.createSessionFromCommand();
    }),
    vscode.commands.registerCommand('ostv.startServer', () => {
      vscode.commands.executeCommand('ostv.chat.focus');
      panel.startServerFromCommand();
    }),
    vscode.commands.registerCommand('ostv.checkStatus', () => {
      vscode.commands.executeCommand('ostv.chat.focus');
      panel.checkStatusFromCommand();
    }),
  );

  healthCheck();
}

export function deactivate() {
  /* nothing to clean up */
}

async function healthCheck() {
  const c = vscode.workspace.getConfiguration('ostv');
  const serverUrl = c.get<string>('serverUrl', 'http://127.0.0.1:4096');
  const username = c.get<string>('username', 'opencode');
  const password = c.get<string>('password', '') || process.env.OPENCODE_SERVER_PASSWORD || '';

  const client = new OpenCodeClient({ serverUrl, username, password });
  try {
    const health = await client.health();
    vscode.window.setStatusBarMessage(`opencode server ${health.version} ✓`, 5000);

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
      try {
        const p = await client.serverPath();
        const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
        const wsPath = norm(workspaceFolder.uri.fsPath);
        const srvPath = norm(p.directory);
        const ok = wsPath === srvPath || wsPath.startsWith(srvPath + '/') || srvPath.startsWith(wsPath + '/');
        if (!ok) {
          vscode.window.showWarningMessage(
            `opencode server 的工作目录是 ${p.directory}，与当前工作区 ${workspaceFolder.uri.fsPath} 不一致。` +
              `AI 的文件操作会落在 server 目录。请在项目目录启动 serve 或调整 ostv.serverUrl。`,
          );
        }
      } catch (err) {
        vscode.window.showWarningMessage(`无法获取 opencode server 工作目录: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    const msg = vscode.window.showErrorMessage(
      `无法连接 opencode server (${serverUrl})。请先运行: opencode serve --port 4096`,
      '重试',
    );
    msg.then((action) => {
      if (action === '重试') healthCheck();
    });
  }
}