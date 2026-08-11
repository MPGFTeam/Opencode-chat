(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const state = {
    sessions: [],
    current: null,
    models: [],
    sending: false,
  };

  const $ = (id) => document.getElementById(id);
  const chat = $('chat');
  const welcome = $('welcome');
  const chatApp = $('chat-app');

  /* ---------------- 欢迎页 ---------------- */

  function showChat() {
    welcome.hidden = true;
    chatApp.hidden = false;
  }

  function showWelcome() {
    chatApp.hidden = true;
    welcome.hidden = false;
  }

  function renderStatus(s) {
    const conn = $('st-conn');
    if (s.busy) {
      conn.textContent = '启动中…';
      conn.className = 'st-value st-busy';
    } else if (s.connected) {
      conn.textContent = '已连接';
      conn.className = 'st-value st-ok';
    } else {
      conn.textContent = '未连接';
      conn.className = 'st-value st-err';
    }
    $('st-version').textContent = s.version || '-';
    $('st-port').textContent = s.port || '-';
    $('st-srvdir').textContent = s.serverDir || '-';
    $('st-wsdir').textContent = s.wsDir || '-';
    const err = $('status-error');
    if (s.error) {
      err.textContent = '连接失败: ' + s.error;
      err.hidden = false;
    } else {
      err.hidden = true;
    }
  }

  /* ---------------- 基础工具 ---------------- */

  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtJson(v) {
    try {
      if (typeof v === 'string') return v;
      return JSON.stringify(v, null, 2);
    } catch (e) {
      return String(v);
    }
  }

  function scrollBottom() {
    chat.scrollTop = chat.scrollHeight;
  }

  /* ---------------- 消息渲染 ---------------- */

  function msgEl(mid) {
    let el = chat.querySelector('[data-mid="' + mid + '"]');
    if (el) return el;
    el = document.createElement('div');
    el.className = 'msg assistant';
    el.dataset.mid = mid;
    el.innerHTML = '<div class="meta">assistant</div><div class="content"></div>';
    chat.appendChild(el);
    scrollBottom();
    return el;
  }

  function partEl(mid, pid) {
    const content = msgEl(mid).querySelector('.content');
    let el = content.querySelector('[data-pid="' + pid + '"]');
    if (!el) {
      el = document.createElement('div');
      el.dataset.pid = pid;
      content.appendChild(el);
    }
    return el;
  }

  function renderPart(mid, part, delta) {
    const el = partEl(mid, part.id);
    switch (part.type) {
      case 'text': {
        el.className = 'part text';
        const text = delta ? (el.dataset.t || '') + delta : part.text || '';
        el.dataset.t = text;
        el.textContent = text;
        break;
      }
      case 'reasoning': {
        if (el.dataset.rendered) break;
        el.dataset.rendered = '1';
        el.className = 'part reasoning';
        const val = delta ? (el.dataset.t || '') + delta : part.text || '';
        el.dataset.t = val;
        el.innerHTML = '<details><summary>推理</summary><pre></pre></details>';
        el.querySelector('pre').textContent = val;
        break;
      }
      case 'tool': {
        el.className = 'part tool';
        const st = part.state || {};
        const badge = st.status === 'completed'
          ? '<span class="ok">完成</span>'
          : st.status === 'error'
            ? '<span class="err">出错</span>'
            : '<span class="run">运行中</span>';
        const input = st.input ? esc(fmtJson(st.input)) : '';
        const output = st.output ? esc(fmtJson(st.output)) : '';
        el.innerHTML =
          '<div class="tool-head">' + esc(part.tool || 'tool') + ' ' + badge + '</div>' +
          (input ? '<details class="io"><summary>输入</summary><pre>' + input + '</pre></details>' : '') +
          (output ? '<details class="io"><summary>输出</summary><pre>' + output + '</pre></details>' : '');
        break;
      }
      case 'step-start': {
        el.className = 'part step';
        el.textContent = '▶ 步骤';
        break;
      }
      default:
        break;
    }
    scrollBottom();
  }

  /* ---------------- 会话下拉 ---------------- */

  function fillSessions(sessions) {
    state.sessions = sessions || [];
    const sel = $('session-select');
    sel.innerHTML = '';
    for (const s of state.sessions) {
      const opt = document.createElement('option');
      opt.value = s.id;
      const title = (s.title || '会话 ' + s.id.slice(0, 6));
      opt.textContent = title.slice(0, 40);
      sel.appendChild(opt);
    }
    if (state.current) sel.value = state.current;
  }

  function clearChat() {
    chat.innerHTML = '';
    state.sending = false;
    $('btn-abort').hidden = true;
    $('btn-send').hidden = false;
  }

  /* ---------------- 模型下拉 ---------------- */

  function fillModels(providers) {
    state.models = [];
    const sel = $('model-select');
    sel.innerHTML = '';
    for (const p of providers || []) {
      for (const m of p.models || []) {
        state.models.push(p.providerID + '/' + m);
      }
    }
    if (state.models.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '默认模型';
      sel.appendChild(opt);
      return;
    }
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '默认模型';
    sel.appendChild(opt);
    for (const m of state.models) {
      const o = document.createElement('option');
      o.value = m;
      o.textContent = m;
      sel.appendChild(o);
    }
  }

  /* ---------------- 事件处理 ---------------- */

  window.addEventListener('message', (e) => {
    const m = e.data;
    switch (m.type) {
      case 'status': {
        renderStatus(m);
        if (m.connected) showChat();
        else showWelcome();
        break;
      }
      case 'server-starting': {
        $('st-conn').textContent = '启动中…';
        $('st-conn').className = 'st-value st-busy';
        $('st-port').textContent = String(m.port);
        $('start-progress').hidden = false;
        $('btn-start-server').disabled = true;
        break;
      }
      case 'server-started': {
        $('start-progress').hidden = true;
        $('btn-start-server').disabled = false;
        vscode.postMessage({ type: 'status-check' });
        break;
      }
      case 'status-check-again': {
        vscode.postMessage({ type: 'status-check' });
        break;
      }
      case 'config': {
        if (m.defaultModel) {
          const d = document.createElement('option');
          d.value = '';
          d.textContent = '默认模型 (' + m.defaultModel + ')';
          const sel = $('model-select');
          sel.insertBefore(d, sel.firstChild);
        }
        break;
      }
      case 'sessions':
        fillSessions(m.sessions);
        break;
      case 'switch-session': {
        state.current = m.sessionID;
        fillSessions(state.sessions);
        clearChat();
        for (const msg of m.messages || []) {
          if (msg.info.role === 'user') {
            for (const p of msg.parts || []) {
              if (p.type === 'text') userBubble(p.text || '');
            }
          } else {
            for (const p of msg.parts || []) renderPart(msg.info.id, p);
          }
        }
        scrollBottom();
        break;
      }
      case 'options':
        fillModels(m.providers);
        break;
      case 'user-message':
        userBubble(m.text);
        state.sending = true;
        $('btn-abort').hidden = false;
        $('btn-send').hidden = true;
        scrollBottom();
        break;
      case 'assistant-message':
        state.sending = true;
        break;
      case 'part-updated':
        renderPart(String(m.messageID || ''), m.part);
        break;
      case 'ai-changed-file': {
        const d = document.createElement('div');
        d.className = 'part diff-card';
        d.innerHTML =
          '<div class="diff-title">📄 ' + esc(m.file) + ' 已被修改</div>' +
          '<button class="diff-open" data-file="' + esc(m.file) + '">查看改动 (VS Code diff)</button>';
        d.querySelector('.diff-open').addEventListener('click', () => {
          vscode.postMessage({ type: 'view-diff', file: m.file });
        });
        chat.appendChild(d);
        scrollBottom();
        break;
      }
      case 'idle':
        state.sending = false;
        $('btn-abort').hidden = true;
        $('btn-send').hidden = false;
        break;
      case 'error':
        state.sending = false;
        $('btn-abort').hidden = true;
        $('btn-send').hidden = false;
        toast(m.message || '出错了');
        break;
    }
  });

  function toast(text) {
    const d = document.createElement('div');
    d.className = 'toast';
    d.textContent = text;
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 5000);
  }

  function userBubble(text) {
    const d = document.createElement('div');
    d.className = 'msg user';
    d.innerHTML = '<div class="bubble">' + esc(text) + '</div>';
    chat.appendChild(d);
    scrollBottom();
  }

  /* ---------------- 交互 ---------------- */

  const input = $('input');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  $('btn-send').addEventListener('click', send);
  $('btn-abort').addEventListener('click', () => {
    vscode.postMessage({ type: 'abort' });
  });
  $('btn-start-server').addEventListener('click', () => {
    vscode.postMessage({ type: 'start-server' });
  });
  $('btn-check-status').addEventListener('click', () => {
    vscode.postMessage({ type: 'status-check' });
  });
  $('btn-new').addEventListener('click', () => {
    vscode.postMessage({ type: 'new-session' });
  });
  $('session-select').addEventListener('change', (e) => {
    vscode.postMessage({ type: 'switch-session', sessionID: e.target.value });
  });

  function send() {
    const text = input.value.trim();
    if (!text || state.sending) return;
    input.value = '';
    const model = $('model-select').value || undefined;
    vscode.postMessage({ type: 'send', text, model });
  }

  vscode.postMessage({ type: 'init' });
})();