export interface PartState {
  status: 'pending' | 'running' | 'completed' | 'error';
  input?: unknown;
  output?: unknown;
  title?: string;
  error?: string;
}

export interface Part {
  id: string;
  type: 'text' | 'reasoning' | 'tool' | 'step-start' | 'step-finish' | 'snapshot' | 'patch' | 'agent' | 'compaction' | 'retry' | 'file';
  text?: string;
  tool?: string;
  callID?: string;
  state?: PartState;
  files?: string[];
  [key: string]: unknown;
}

export interface Message {
  info: {
    id: string;
    role: 'user' | 'assistant' | 'system';
    sessionID?: string;
    time?: { created: number; updated: number };
  };
  parts: Part[];
}

export interface Session {
  id: string;
  title?: string;
  time?: { created: number; updated: number };
}

export interface FileDiff {
  file: string;
  before: string;
  after: string;
  additions: number;
  deletions: number;
}

export interface ServerEvent {
  type: string;
  properties?: Record<string, unknown>;
}

export interface ClientOptions {
  serverUrl: string;
  username: string;
  password: string;
}

export class OpencodeError extends Error {
  constructor(message: string, public readonly status?: number, public readonly body?: string) {
    super(message);
  }
}

export class OpenCodeClient {
  private base: string;
  private authHeader: string;
  private abortCtrl: AbortController | null = null;

  constructor(private config: ClientOptions) {
    const url = config.serverUrl.replace(/\/+$/, '');
    this.base = url.replace(/\/opencode$/, '');
    this.authHeader = 'Basic ' + Buffer.from(`${config.username}:${config.password}`).toString('base64');
  }

  private async raw(path: string, init?: RequestInit): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      ...(init?.headers as Record<string, string> | undefined),
    };
    const res = await fetch(this.base + path, { ...init, headers });
    return res;
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.raw(path, init);
    if (!res.ok) {
      let body = '';
      try { body = await res.text(); } catch { /* ignore */ }
      throw new OpencodeError(`HTTP ${res.status} ${res.statusText}`, res.status, body);
    }
    return (await res.json()) as T;
  }

  async health(): Promise<{ healthy: boolean; version: string }> {
    return this.json('/global/health');
  }

  async testConnection(): Promise<boolean> {
    try {
      const h = await this.health();
      return !!h && h.healthy === true;
    } catch {
      return false;
    }
  }

  async serverPath(): Promise<{ directory: string }> {
    return this.json('/path');
  }

  async listSessions(): Promise<Session[]> {
    return this.json('/session');
  }

  async createSession(title?: string): Promise<Session> {
    return this.json('/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(title ? { title } : {}),
    });
  }

  async messages(sessionId: string): Promise<Message[]> {
    return this.json(`/session/${sessionId}/message`);
  }

  async prompt(sessionId: string, text: string, model?: { providerID: string; modelID: string }): Promise<void> {
    const body: Record<string, unknown> = { parts: [{ type: 'text', text }] };
    if (model) body.model = model;
    const res = await this.raw(`/session/${sessionId}/prompt_async`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let b = '';
      try { b = await res.text(); } catch { /* ignore */ }
      throw new OpencodeError(`HTTP ${res.status} ${res.statusText}`, res.status, b);
    }
  }

  async abort(sessionId: string): Promise<void> {
    await this.raw(`/session/${sessionId}/abort`, { method: 'POST' });
  }

  async agents(): Promise<{ id: string; name?: string; mode?: string; internal?: boolean }[]> {
    try {
      const all = await this.json<any[]>('/agent');
      return (all || []).filter(
        (a) => !a.internal && a.mode !== 'subagent' && !(a.name && a.name.startsWith('Hidden')),
      );
    } catch {
      return [];
    }
  }

  async providers(): Promise<{ providerID: string; models: string[] }[]> {
    try {
      const all = await this.json<any>('/config/providers');
      const list: { providerID: string; models: string[] }[] = [];
      for (const p of all.providers || []) {
        const models = (p.models || []).map((m: any) => m.id).filter(Boolean);
        list.push({ providerID: p.id, models });
      }
      return list;
    } catch {
      return [];
    }
  }

  /**
   * 订阅 SSE 事件流。返回停止函数。断线自动重连（最多 5 次，间隔 2s）。
   */
  subscribeEvents(handler: (ev: ServerEvent) => void, onDrop?: (err?: unknown) => void): () => void {
    let stopped = false;
    let retries = 0;

    const connect = async () => {
      try {
        const res = await fetch(this.base + '/event', {
          headers: { Authorization: this.authHeader, Accept: 'text/event-stream' },
        });
        if (!res.ok || !res.body) throw new OpencodeError(`HTTP ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';

        while (!stopped) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const ev = this.parseSse(chunk);
            if (ev) handler(ev);
          }
        }
        retries = 0;
      } catch (err) {
        if (stopped) return;
        if (retries < 5) {
          retries++;
          setTimeout(connect, 2000);
        } else {
          onDrop?.(err);
        }
      }
    };

    connect();
    return () => {
      stopped = true;
      this.abortCtrl?.abort();
    };
  }

  private parseSse(chunk: string): ServerEvent | null {
    let type = '';
    let data = '';
    for (const line of chunk.split('\n')) {
      if (line.startsWith('event:')) type = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (!data) return null;
    try {
      const parsed = JSON.parse(data);
      if (!type && parsed && typeof parsed.type === 'string') type = parsed.type;
      return { type, properties: parsed };
    } catch {
      return null;
    }
  }
}