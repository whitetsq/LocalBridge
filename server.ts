import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isProduction = process.env.NODE_ENV === 'production';

const app = express();
app.use(express.json({ limit: '25mb' }));

// ============================================================================
// Companion Control Plane (AI Studio Chat <-> Right-hand Dashboard <-> Local Tunnel)
// Credentials live strictly in server process memory — never persisted or printed in chat.
// ============================================================================

type SecurityPolicy = 'approve' | 'allowlist' | 'readonly';

interface GitRepoSummary {
  path: string;
  name: string;
  branch?: string;
  dirtyCount?: number;
}

interface CompanionWorkspaceInfo {
  name: string;
  rootPath: string;
  noShell: boolean;
  readOnly: boolean;
  version?: string;
  branch?: string;
  dirtyCount?: number;
  stack?: string[];
  gitRepos?: GitRepoSummary[];
}

interface CompanionEventItem {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  status: 'pending_approval' | 'running' | 'success' | 'error' | 'rejected';
  source: 'companion-chat' | 'ui';
  startedAt: number;
  durationMs?: number;
  result?: Record<string, unknown>;
  error?: string;
  previewBefore?: string;
  previewAfter?: string;
  filePath?: string;
  command?: string;
}

interface CompanionPendingApproval {
  id: string;
  eventId: string;
  toolName: string;
  args: Record<string, unknown>;
  filePath?: string;
  command?: string;
  previewBefore?: string;
  previewAfter?: string;
  createdAt: number;
  resolve: (decision: {
    approved: boolean;
    note?: string;
    addAllowlistPrefix?: string;
  }) => void;
}

const DEFAULT_COMPANION_ALLOWLIST = [
  'git status',
  'git diff',
  'git log',
  'git branch',
  'npm test',
  'npm run test',
  'npm run lint',
  'npm run build',
  'npx tsc',
  'pnpm test',
  'pnpm lint',
  'pnpm build',
  'pytest',
  'go test',
  'cargo test',
  'cargo check',
];

const SHELL_METACHAR_RE = /[;&|`$><\n\r]/;

const READ_ONLY_TOOLS = new Set([
  'inspect_workspace',
  'list_directory',
  'find_files',
  'read_file',
  'read_files',
  'search_files',
  'git_inspect',
  'git_diff',
]);

const WRITE_TOOLS = new Set([
  'edit_file',
  'write_file',
  'delete_file',
  'create_directory',
  'move_path',
]);

const companionState: {
  connected: boolean;
  tunnelUrl: string;
  token: string;
  workspace: CompanionWorkspaceInfo | null;
  policy: SecurityPolicy;
  autoApproveFileWrites: boolean;
  allowlist: string[];
  events: CompanionEventItem[];
  pendingApprovals: Map<string, CompanionPendingApproval>;
  sseClients: Set<express.Response>;
} = {
  connected: false,
  tunnelUrl: '',
  token: '',
  workspace: null,
  policy: 'approve',
  autoApproveFileWrites: false,
  allowlist: [...DEFAULT_COMPANION_ALLOWLIST],
  events: [],
  pendingApprovals: new Map(),
  sseClients: new Set(),
};

function companionId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function isAllowlistedCmd(command: string, allowlist: string[]): boolean {
  const trimmed = command.trim();
  if (!trimmed || SHELL_METACHAR_RE.test(trimmed)) return false;
  const normalized = trimmed.replace(/\s+/g, ' ');
  return allowlist.some((raw) => {
    const p = raw.trim().replace(/\s+/g, ' ');
    return Boolean(p) && (normalized === p || normalized.startsWith(`${p} `));
  });
}

function getPublicCompanionState() {
  return {
    connected: companionState.connected,
    tunnelUrl: companionState.tunnelUrl,
    workspace: companionState.workspace,
    policy: companionState.policy,
    autoApproveFileWrites: companionState.autoApproveFileWrites,
    allowlist: companionState.allowlist,
    events: companionState.events.slice(0, 80),
    pendingApprovals: Array.from(companionState.pendingApprovals.values()).map((a) => ({
      id: a.id,
      eventId: a.eventId,
      toolName: a.toolName,
      args: a.args,
      filePath: a.filePath,
      command: a.command,
      previewBefore: a.previewBefore,
      previewAfter: a.previewAfter,
      createdAt: a.createdAt,
    })),
  };
}

function broadcastCompanionState() {
  const payload = `data: ${JSON.stringify(getPublicCompanionState())}\n\n`;
  for (const client of companionState.sseClients) {
    try {
      client.write(payload);
    } catch {
      companionState.sseClients.delete(client);
    }
  }
}

function pushCompanionEvent(ev: CompanionEventItem) {
  companionState.events = [ev, ...companionState.events].slice(0, 80);
  broadcastCompanionState();
}

function updateCompanionEvent(id: string, patch: Partial<CompanionEventItem>) {
  companionState.events = companionState.events.map((ev) =>
    ev.id === id ? { ...ev, ...patch } : ev
  );
  broadcastCompanionState();
}

function normalizeTunnelUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('隧道地址不能为空');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('隧道地址格式无效，请输入完整的 https://... 地址');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('隧道地址必须以 https:// 或 http:// 开头');
  }
  parsed.hash = '';
  return parsed.toString().replace(/\/+$/, '');
}

async function fetchTunnelJson(
  tunnelUrl: string,
  token: string,
  endpoint: string,
  init: RequestInit = {}
): Promise<Record<string, unknown>> {
  const url = `${tunnelUrl}${endpoint}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-Bridge-Token': token,
      'ngrok-skip-browser-warning': 'true',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  if (!text.trim()) {
    throw new Error(`隧道返回空响应 (HTTP ${res.status})`);
  }
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(
      `隧道返回了非 JSON 内容 (HTTP ${res.status})，请确认 ngrok / cloudflared 已正确指向 127.0.0.1:4829。`
    );
  }
  if (!res.ok || data.ok === false) {
    throw new Error(String(data.error || `隧道请求失败 (HTTP ${res.status})`));
  }
  return data;
}

async function callActiveTunnelTool(
  tool: string,
  args: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  if (!companionState.connected || !companionState.tunnelUrl || !companionState.token) {
    throw new Error('伴侣隧道尚未连接，请先在右侧 LocalBridge 控制台绑定本机隧道。');
  }
  const data = await fetchTunnelJson(companionState.tunnelUrl, companionState.token, '/api/tool', {
    method: 'POST',
    body: JSON.stringify({ tool, args }),
  });
  return (data.result || {}) as Record<string, unknown>;
}

async function prepareCompanionPreview(
  toolName: string,
  args: Record<string, unknown>
): Promise<{ previewBefore?: string; previewAfter?: string }> {
  const filePath = String(args.path || '');
  if (!filePath) return {};

  if (toolName === 'write_file') {
    let before = '';
    try {
      const existing = await callActiveTunnelTool('read_file', {
        path: filePath,
        startLine: 1,
        endLine: 4000,
      });
      before = String(existing.content ?? '');
    } catch {
      before = '';
    }
    return { previewBefore: before, previewAfter: String(args.content ?? '') };
  }

  if (toolName === 'edit_file') {
    try {
      const existing = await callActiveTunnelTool('read_file', {
        path: filePath,
        startLine: 1,
        endLine: 4000,
      });
      const before = String(existing.content ?? '');
      const editList =
        Array.isArray(args.edits) && args.edits.length > 0
          ? (args.edits as Array<{ oldText?: unknown; newText?: unknown; replaceAll?: unknown }>)
          : [{ oldText: args.oldText, newText: args.newText, replaceAll: args.replaceAll }];

      let after = before;
      for (const item of editList) {
        const oldText = String(item.oldText ?? '');
        const newText = String(item.newText ?? '');
        const replaceAll = Boolean(item.replaceAll);
        if (!oldText) continue;
        after = replaceAll ? after.split(oldText).join(newText) : after.replace(oldText, newText);
      }
      return { previewBefore: before, previewAfter: after };
    } catch {
      return {};
    }
  }

  return {};
}

// Companion REST + SSE endpoints
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, mode: 'companion-control-plane', connected: companionState.connected });
});

app.get('/api/companion/state', (_req, res) => {
  res.json(getPublicCompanionState());
});

app.get('/api/companion/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  companionState.sseClients.add(res);
  res.write(`data: ${JSON.stringify(getPublicCompanionState())}\n\n`);

  const keepalive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(keepalive);
      companionState.sseClients.delete(res);
    }
  }, 15000);

  req.on('close', () => {
    clearInterval(keepalive);
    companionState.sseClients.delete(res);
  });
});

app.post('/api/companion/connect', async (req, res) => {
  try {
    const body = (req.body || {}) as { tunnelUrl?: string; token?: string };
    const tunnelUrl = normalizeTunnelUrl(String(body.tunnelUrl || ''));
    const token = String(body.token || '').trim();
    if (!token) {
      res.status(400).json({ error: '请输入 LocalBridge 的安全 Token。' });
      return;
    }

    const health = await fetchTunnelJson(tunnelUrl, token, '/health', { method: 'GET' });
    const inspectedRes = await fetchTunnelJson(tunnelUrl, token, '/api/tool', {
      method: 'POST',
      body: JSON.stringify({ tool: 'inspect_workspace', args: { maxDepth: 2 } }),
    });
    const inspected = (inspectedRes.result || {}) as Record<string, unknown>;

    companionState.connected = true;
    companionState.tunnelUrl = tunnelUrl;
    companionState.token = token;
    companionState.workspace = {
      name: String(health.name || inspected.name || 'local-workspace'),
      rootPath: String(health.rootPath || inspected.rootPath || '.'),
      noShell: Boolean(health.noShell ?? inspected.noShell),
      readOnly: Boolean(health.readOnly ?? inspected.readOnly),
      version: typeof health.version === 'string' ? health.version : undefined,
      branch: typeof inspected.branch === 'string' ? inspected.branch : undefined,
      dirtyCount: typeof inspected.dirtyCount === 'number' ? inspected.dirtyCount : undefined,
      stack: Array.isArray(inspected.stack) ? inspected.stack.map(String) : undefined,
      gitRepos: Array.isArray(inspected.gitRepos)
        ? (inspected.gitRepos as GitRepoSummary[])
        : undefined,
    };

    broadcastCompanionState();
    res.json({ ok: true, state: getPublicCompanionState() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

app.post('/api/companion/disconnect', (_req, res) => {
  for (const pending of companionState.pendingApprovals.values()) {
    pending.resolve({ approved: false, note: '用户已断开伴侣隧道' });
  }
  companionState.pendingApprovals.clear();
  companionState.connected = false;
  companionState.tunnelUrl = '';
  companionState.token = '';
  companionState.workspace = null;
  broadcastCompanionState();
  res.json({ ok: true, state: getPublicCompanionState() });
});

app.post('/api/companion/policy', (req, res) => {
  const body = (req.body || {}) as {
    policy?: SecurityPolicy;
    autoApproveFileWrites?: boolean;
    allowlist?: string[];
  };
  if (body.policy === 'approve' || body.policy === 'allowlist' || body.policy === 'readonly') {
    companionState.policy = body.policy;
  }
  if (typeof body.autoApproveFileWrites === 'boolean') {
    companionState.autoApproveFileWrites = body.autoApproveFileWrites;
  }
  if (Array.isArray(body.allowlist)) {
    companionState.allowlist = body.allowlist.map((s) => String(s).trim()).filter(Boolean);
  }
  broadcastCompanionState();
  res.json({ ok: true, state: getPublicCompanionState() });
});

app.post('/api/companion/events/clear', (_req, res) => {
  companionState.events = [];
  broadcastCompanionState();
  res.json({ ok: true });
});

app.post('/api/companion/approvals/:id/resolve', (req, res) => {
  const id = req.params.id;
  const pending = companionState.pendingApprovals.get(id);
  if (!pending) {
    res.status(404).json({ error: '该审批请求已失效或已处理' });
    return;
  }
  const body = (req.body || {}) as {
    approved?: boolean;
    note?: string;
    addAllowlistPrefix?: string;
  };
  if (body.addAllowlistPrefix && typeof body.addAllowlistPrefix === 'string') {
    const prefix = body.addAllowlistPrefix.trim();
    if (prefix && !companionState.allowlist.includes(prefix)) {
      companionState.allowlist = [prefix, ...companionState.allowlist];
    }
  }
  companionState.pendingApprovals.delete(id);
  pending.resolve({
    approved: Boolean(body.approved),
    note: body.note,
    addAllowlistPrefix: body.addAllowlistPrefix,
  });
  broadcastCompanionState();
  res.json({ ok: true });
});

// Direct UI proxy (file tree, file preview, git inspect, manual terminal commands)
app.post('/api/companion/ui-tool', async (req, res) => {
  try {
    const body = (req.body || {}) as { tool?: string; args?: Record<string, unknown> };
    const tool = String(body.tool || '');
    if (!tool) {
      res.status(400).json({ error: '缺少 tool 名称' });
      return;
    }
    const result = await callActiveTunnelTool(tool, body.args || {});
    res.json({ ok: true, result });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Kill a running local command through the active tunnel
app.post('/api/companion/kill', async (req, res) => {
  try {
    if (!companionState.connected || !companionState.tunnelUrl || !companionState.token) {
      res.status(400).json({ error: '伴侣隧道未连接' });
      return;
    }
    const body = (req.body || {}) as { processId?: string };
    const processId = String(body.processId || '').trim();
    if (!processId) {
      res.status(400).json({ error: '缺少 processId' });
      return;
    }
    const data = await fetchTunnelJson(companionState.tunnelUrl, companionState.token, '/api/kill', {
      method: 'POST',
      body: JSON.stringify({ processId }),
    });
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Companion chat execution gate (enforces policy + live UI diff/command approval)
app.post('/api/companion/call', async (req, res) => {
  const body = (req.body || {}) as { tool?: string; args?: Record<string, unknown> };
  const toolName = String(body.tool || '').trim();
  const args = body.args && typeof body.args === 'object' ? body.args : {};

  if (!toolName) {
    res.status(400).json({ ok: false, error: '缺少 tool 参数' });
    return;
  }

  if (!companionState.connected) {
    res.status(409).json({
      ok: false,
      error: '尚未绑定本机隧道。请先在右侧 LocalBridge 面板填入隧道配对串或地址 + Token。',
    });
    return;
  }

  const eventId = companionId('ev');
  const startedAt = Date.now();
  const filePath =
    typeof args.path === 'string'
      ? args.path
      : typeof args.from === 'string'
        ? args.from
        : undefined;
  const command = typeof args.command === 'string' ? args.command : undefined;

  if (companionState.policy === 'readonly' && !READ_ONLY_TOOLS.has(toolName)) {
    const error = '当前处于只读模式（readonly），已拦截写入或命令执行。请在右侧切换策略后重试。';
    pushCompanionEvent({
      id: eventId,
      toolName,
      args,
      status: 'rejected',
      source: 'companion-chat',
      startedAt,
      durationMs: 0,
      error,
      filePath,
      command,
    });
    res.status(403).json({ ok: false, error });
    return;
  }

  let needsApproval = false;
  if (WRITE_TOOLS.has(toolName)) {
    needsApproval = !(
      companionState.policy === 'allowlist' && companionState.autoApproveFileWrites
    );
  } else if (toolName === 'run_command') {
    needsApproval = !(
      companionState.policy === 'allowlist' &&
      isAllowlistedCmd(command || '', companionState.allowlist)
    );
  }

  if (needsApproval) {
    const preview = await prepareCompanionPreview(toolName, args);
    const approvalId = companionId('apr');

    pushCompanionEvent({
      id: eventId,
      toolName,
      args,
      status: 'pending_approval',
      source: 'companion-chat',
      startedAt,
      filePath,
      command,
      previewBefore: preview.previewBefore,
      previewAfter: preview.previewAfter,
    });

    const decision = await new Promise<{
      approved: boolean;
      note?: string;
      addAllowlistPrefix?: string;
    }>((resolve) => {
      const timeout = setTimeout(() => {
        if (companionState.pendingApprovals.has(approvalId)) {
          companionState.pendingApprovals.delete(approvalId);
          broadcastCompanionState();
          resolve({ approved: false, note: '等待右侧审批超时（180s）' });
        }
      }, 180000);

      companionState.pendingApprovals.set(approvalId, {
        id: approvalId,
        eventId,
        toolName,
        args,
        filePath,
        command,
        previewBefore: preview.previewBefore,
        previewAfter: preview.previewAfter,
        createdAt: Date.now(),
        resolve: (d) => {
          clearTimeout(timeout);
          resolve(d);
        },
      });
      broadcastCompanionState();
    });

    if (!decision.approved) {
      const msg = decision.note ? `用户拒绝了操作：${decision.note}` : '用户拒绝了该操作';
      updateCompanionEvent(eventId, {
        status: 'rejected',
        error: msg,
        durationMs: Date.now() - startedAt,
      });
      res.status(403).json({ ok: false, rejected: true, error: msg });
      return;
    }

    updateCompanionEvent(eventId, { status: 'running' });
  } else {
    pushCompanionEvent({
      id: eventId,
      toolName,
      args,
      status: 'running',
      source: 'companion-chat',
      startedAt,
      filePath,
      command,
    });
  }

  try {
    const result = await callActiveTunnelTool(toolName, args);
    const durationMs = Date.now() - startedAt;
    updateCompanionEvent(eventId, {
      status: 'success',
      result,
      durationMs,
    });
    res.json({ ok: true, result, durationMs });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateCompanionEvent(eventId, {
      status: 'error',
      error: message,
      durationMs: Date.now() - startedAt,
    });
    res.status(400).json({ ok: false, error: message });
  }
});

// Guarantee JSON responses for any unhandled /api/* errors
app.use('/api', (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = err instanceof Error ? err.message : 'Internal API error';
  if (!res.headersSent) {
    res.status(500).json({ error: message });
  }
});

async function startServer() {
  if (!isProduction) {
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const PORT = 3000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`LocalBridge Companion Control Plane running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
