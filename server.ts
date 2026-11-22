import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
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
// LocalBridge Companion Control Plane v2.1
// Credentials & revert snapshots live strictly in server process memory.
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
  allowSecrets?: boolean;
  branch?: string;
  dirtyCount?: number;
  stack?: string[];
  gitRepos?: GitRepoSummary[];
}

interface CompanionHealth {
  ok: boolean;
  latencyMs?: number;
  lastCheckedAt?: number;
  error?: string;
}

interface RevertFileEntry {
  filePath: string;
  existed: boolean;
  content: string;
}

interface RevertSnapshot {
  entries: RevertFileEntry[];
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
  processId?: string;
  liveStdout?: string;
  liveStderr?: string;
  canRevert?: boolean;
  reverted?: boolean;
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
  'node --test',
  'npx tsc',
  'pnpm test',
  'pnpm lint',
  'pnpm build',
  'pytest',
  'go test',
  'cargo test',
  'cargo check',
];

const UNSAFE_METACHAR_RE = /[;|`$><\n\r]/;
const SINGLE_AMP_RE = /(?:^|[^&])&(?:[^&]|$)/;

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
  'write_files',
  'delete_file',
  'create_directory',
  'move_path',
]);

const REVERTABLE_TOOLS = new Set(['edit_file', 'write_file', 'write_files', 'delete_file']);

const SESSION_CACHE_FILE = path.join(os.tmpdir(), 'localbridge-companion-session.json');

const companionState: {
  connected: boolean;
  tunnelUrl: string;
  token: string;
  workspace: CompanionWorkspaceInfo | null;
  health: CompanionHealth;
  policy: SecurityPolicy;
  autoApproveFileWrites: boolean;
  allowlist: string[];
  events: CompanionEventItem[];
  revertSnapshots: Map<string, RevertSnapshot>;
  pendingApprovals: Map<string, CompanionPendingApproval>;
  sseClients: Set<express.Response>;
} = {
  connected: false,
  tunnelUrl: '',
  token: '',
  workspace: null,
  health: { ok: false },
  policy: 'approve',
  autoApproveFileWrites: false,
  allowlist: [...DEFAULT_COMPANION_ALLOWLIST],
  events: [],
  revertSnapshots: new Map(),
  pendingApprovals: new Map(),
  sseClients: new Set(),
};

function persistEphemeralSession() {
  if (!companionState.connected || !companionState.tunnelUrl || !companionState.token) return;
  try {
    const payload = JSON.stringify({
      tunnelUrl: companionState.tunnelUrl,
      token: companionState.token,
      workspace: companionState.workspace,
      policy: companionState.policy,
      autoApproveFileWrites: companionState.autoApproveFileWrites,
      allowlist: companionState.allowlist,
      savedAt: Date.now(),
    });
    fs.writeFileSync(SESSION_CACHE_FILE, payload, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // ignore tmpdir write errors
  }
}

function clearEphemeralSession() {
  try {
    if (fs.existsSync(SESSION_CACHE_FILE)) {
      fs.unlinkSync(SESSION_CACHE_FILE);
    }
  } catch {
    // ignore tmpdir unlink errors
  }
}

function restoreEphemeralSession() {
  try {
    if (!fs.existsSync(SESSION_CACHE_FILE)) return;
    const raw = fs.readFileSync(SESSION_CACHE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as {
      tunnelUrl?: string;
      token?: string;
      workspace?: CompanionWorkspaceInfo | null;
      policy?: SecurityPolicy;
      autoApproveFileWrites?: boolean;
      allowlist?: string[];
    };
    if (!parsed.tunnelUrl || !parsed.token) return;
    companionState.connected = true;
    companionState.tunnelUrl = parsed.tunnelUrl;
    companionState.token = parsed.token;
    companionState.workspace = parsed.workspace || null;
    companionState.health = { ok: true, lastCheckedAt: Date.now() };
    if (parsed.policy === 'approve' || parsed.policy === 'allowlist' || parsed.policy === 'readonly') {
      companionState.policy = parsed.policy;
    }
    if (typeof parsed.autoApproveFileWrites === 'boolean') {
      companionState.autoApproveFileWrites = parsed.autoApproveFileWrites;
    }
    if (Array.isArray(parsed.allowlist) && parsed.allowlist.length > 0) {
      companionState.allowlist = parsed.allowlist;
    }
  } catch {
    // ignore malformed cache
  }
}

restoreEphemeralSession();

function companionId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function isSingleSegmentAllowlisted(segment: string, allowlist: string[]): boolean {
  const normalized = segment.trim().replace(/\s+/g, ' ');
  if (!normalized) return false;
  return allowlist.some((raw) => {
    const p = raw.trim().replace(/\s+/g, ' ');
    return Boolean(p) && (normalized === p || normalized.startsWith(`${p} `));
  });
}

function isAllowlistedCmd(command: string, allowlist: string[]): boolean {
  const trimmed = command.trim();
  if (!trimmed || UNSAFE_METACHAR_RE.test(trimmed) || SINGLE_AMP_RE.test(trimmed)) return false;
  const segments = trimmed.split('&&').map((s) => s.trim());
  if (segments.some((s) => !s)) return false;
  return segments.every((seg) => isSingleSegmentAllowlisted(seg, allowlist));
}

function supportsInlineRevertSnapshot(version?: string): boolean {
  if (!version) return false;
  const [maj, min] = version.split('.').map((n) => Number(n) || 0);
  return maj > 2 || (maj === 2 && min >= 2);
}

function getPublicCompanionState() {
  return {
    connected: companionState.connected,
    tunnelUrl: companionState.tunnelUrl,
    workspace: companionState.workspace,
    health: companionState.health,
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

function storeRevertSnapshot(eventId: string, snap: RevertSnapshot) {
  companionState.revertSnapshots.set(eventId, snap);
  if (companionState.revertSnapshots.size > 50) {
    const oldestKey = companionState.revertSnapshots.keys().next().value;
    if (oldestKey) companionState.revertSnapshots.delete(oldestKey);
  }
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

/**
 * Streams a `run_command` via local-bridge v2.1's NDJSON `/api/tool-stream`,
 * gracefully falling back to `/api/tool` if the local script is v2.0/v1.x.
 */
async function streamActiveTunnelCommand(
  args: Record<string, unknown>,
  onUpdate: (update: { processId?: string; stdout: string; stderr: string }) => void
): Promise<Record<string, unknown>> {
  if (!companionState.connected || !companionState.tunnelUrl || !companionState.token) {
    throw new Error('伴侣隧道尚未连接，请先在右侧 LocalBridge 控制台绑定本机隧道。');
  }

  const processId = String(args.processId || companionId('proc'));
  const payloadArgs = { ...args, processId };
  const url = `${companionState.tunnelUrl}/api/tool-stream`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Bridge-Token': companionState.token,
      'ngrok-skip-browser-warning': 'true',
    },
    body: JSON.stringify({ tool: 'run_command', args: payloadArgs }),
  });

  // Backward compatibility for v2.0/v1.x bridges that don't expose /api/tool-stream yet
  if (res.status === 404) {
    onUpdate({ processId, stdout: '', stderr: '' });
    return await callActiveTunnelTool('run_command', payloadArgs);
  }

  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => '');
    let msg = `命令流执行失败 (HTTP ${res.status})`;
    try {
      const parsed = JSON.parse(errText) as { error?: string };
      if (parsed.error) msg = parsed.error;
    } catch {
      if (errText.trim()) msg = errText.trim().slice(0, 300);
    }
    throw new Error(msg);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let stdout = '';
  let stderr = '';
  let activePid = processId;
  let finalResult: Record<string, unknown> | null = null;
  let lastEmit = 0;

  const flushUpdate = (force = false) => {
    const now = Date.now();
    if (force || now - lastEmit >= 160) {
      lastEmit = now;
      onUpdate({ processId: activePid, stdout, stderr });
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nlIdx = buffer.indexOf('\n');
    while (nlIdx !== -1) {
      const line = buffer.slice(0, nlIdx).trim();
      buffer = buffer.slice(nlIdx + 1);
      if (line) {
        try {
          const msg = JSON.parse(line) as {
            type?: string;
            processId?: string;
            chunk?: string;
            result?: Record<string, unknown>;
            error?: string;
          };
          if (msg.type === 'start' && msg.processId) {
            activePid = msg.processId;
            flushUpdate(true);
          } else if (msg.type === 'stdout' && typeof msg.chunk === 'string') {
            if (stdout.length < 160000) stdout += msg.chunk;
            flushUpdate();
          } else if (msg.type === 'stderr' && typeof msg.chunk === 'string') {
            if (stderr.length < 160000) stderr += msg.chunk;
            flushUpdate();
          } else if (msg.type === 'done' && msg.result) {
            finalResult = msg.result;
          } else if (msg.type === 'error') {
            throw new Error(msg.error || '命令执行出错');
          }
        } catch (err) {
          if (err instanceof SyntaxError) {
            // ignore non-JSON partial frames
          } else {
            throw err;
          }
        }
      }
      nlIdx = buffer.indexOf('\n');
    }
  }

  flushUpdate(true);
  return (
    finalResult || {
      processId: activePid,
      exitCode: 0,
      stdout,
      stderr,
    }
  );
}

async function capturePreWriteSnapshot(
  toolName: string,
  args: Record<string, unknown>
): Promise<RevertSnapshot | null> {
  if (!REVERTABLE_TOOLS.has(toolName)) return null;
  if (toolName === 'write_files') {
    const specs = Array.isArray(args.files) ? (args.files as Array<{ path?: unknown }>) : [];
    if (specs.length === 0) return null;
    const entries: RevertFileEntry[] = [];
    for (const item of specs) {
      const fp = String(item.path || '');
      if (!fp) return null;
      try {
        const existing = await callActiveTunnelTool('read_file', {
          path: fp,
          startLine: 1,
          endLine: 20000,
        });
        if (existing.truncated) return null;
        entries.push({
          filePath: String(existing.path || fp),
          existed: true,
          content: String(existing.content ?? ''),
        });
      } catch {
        entries.push({ filePath: fp, existed: false, content: '' });
      }
    }
    return { entries };
  }

  const filePath = String(args.path || '');
  if (!filePath) return null;
  try {
    const existing = await callActiveTunnelTool('read_file', {
      path: filePath,
      startLine: 1,
      endLine: 20000,
    });
    if (existing.truncated) return null; // avoid truncating huge files on revert
    return {
      entries: [
        {
          filePath: String(existing.path || filePath),
          existed: true,
          content: String(existing.content ?? ''),
        },
      ],
    };
  } catch {
    if (toolName === 'write_file') {
      return { entries: [{ filePath, existed: false, content: '' }] };
    }
    return null;
  }
}

function extractInlineRevertSnapshot(
  toolName: string,
  rawResult: Record<string, unknown>
): { snapshot: RevertSnapshot | null; sanitizedResult: Record<string, unknown> } {
  const sanitized = { ...rawResult };
  delete sanitized.previousContent;
  delete sanitized.previousFiles;

  if (!REVERTABLE_TOOLS.has(toolName)) {
    return { snapshot: null, sanitizedResult: sanitized };
  }

  if (toolName === 'write_files' && Array.isArray(rawResult.previousFiles)) {
    const prevList = rawResult.previousFiles as Array<{
      filePath?: unknown;
      existed?: unknown;
      content?: unknown;
    }>;
    if (prevList.every((p) => !p.existed || typeof p.content === 'string')) {
      return {
        snapshot: {
          entries: prevList.map((p) => ({
            filePath: String(p.filePath || ''),
            existed: Boolean(p.existed),
            content: String(p.content ?? ''),
          })),
        },
        sanitizedResult: sanitized,
      };
    }
    return { snapshot: null, sanitizedResult: sanitized };
  }

  const fp = String(rawResult.path || '');
  const existed = Boolean(rawResult.existed);
  if (!fp) return { snapshot: null, sanitizedResult: sanitized };
  if (existed && typeof rawResult.previousContent !== 'string') {
    return { snapshot: null, sanitizedResult: sanitized };
  }
  return {
    snapshot: {
      entries: [
        {
          filePath: fp,
          existed,
          content: existed ? String(rawResult.previousContent ?? '') : '',
        },
      ],
    },
    sanitizedResult: sanitized,
  };
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

// Background tunnel heartbeat every 30s while connected (tolerates single transient CPU/tunnel spike)
let consecutiveHealthFailures = 0;

async function probeTunnelHealth(immediate = false): Promise<CompanionHealth> {
  if (!companionState.connected || !companionState.tunnelUrl || !companionState.token) {
    consecutiveHealthFailures = 0;
    companionState.health = { ok: false };
    return companionState.health;
  }
  const t0 = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    await fetchTunnelJson(companionState.tunnelUrl, companionState.token, '/health', {
      method: 'GET',
      signal: controller.signal,
    });
    clearTimeout(timer);
    consecutiveHealthFailures = 0;
    companionState.health = {
      ok: true,
      latencyMs: Date.now() - t0,
      lastCheckedAt: Date.now(),
    };
  } catch (err) {
    consecutiveHealthFailures++;
    const errMsg = err instanceof Error ? err.message : '隧道探活失败';
    if (immediate || consecutiveHealthFailures >= 2) {
      companionState.health = {
        ok: false,
        lastCheckedAt: Date.now(),
        error: errMsg,
      };
    }
  }
  broadcastCompanionState();
  return companionState.health;
}

if (companionState.connected) {
  probeTunnelHealth().catch(() => {});
}

setInterval(() => {
  if (companionState.connected) {
    probeTunnelHealth().catch(() => {});
  }
}, 30000);

// ============================================================================
// Companion REST & SSE Routes
// ============================================================================

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

    const t0 = Date.now();
    const health = await fetchTunnelJson(tunnelUrl, token, '/health', { method: 'GET' });
    const latencyMs = Date.now() - t0;
    const inspectedRes = await fetchTunnelJson(tunnelUrl, token, '/api/tool', {
      method: 'POST',
      body: JSON.stringify({ tool: 'inspect_workspace', args: { maxDepth: 2 } }),
    });
    const inspected = (inspectedRes.result || {}) as Record<string, unknown>;

    companionState.connected = true;
    companionState.tunnelUrl = tunnelUrl;
    companionState.token = token;
    companionState.health = { ok: true, latencyMs, lastCheckedAt: Date.now() };
    companionState.workspace = {
      name: String(health.name || inspected.name || 'local-workspace'),
      rootPath: String(health.rootPath || inspected.rootPath || '.'),
      noShell: Boolean(health.noShell ?? inspected.noShell),
      readOnly: Boolean(health.readOnly ?? inspected.readOnly),
      version: typeof health.version === 'string' ? health.version : undefined,
      allowSecrets: Boolean(health.allowSecrets ?? inspected.allowSecrets),
      branch: typeof inspected.branch === 'string' ? inspected.branch : undefined,
      dirtyCount: typeof inspected.dirtyCount === 'number' ? inspected.dirtyCount : undefined,
      stack: Array.isArray(inspected.stack) ? inspected.stack.map(String) : undefined,
      gitRepos: Array.isArray(inspected.gitRepos)
        ? (inspected.gitRepos as GitRepoSummary[])
        : undefined,
    };

    persistEphemeralSession();
    broadcastCompanionState();
    res.json({ ok: true, state: getPublicCompanionState() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

app.post('/api/companion/ping', async (_req, res) => {
  const health = await probeTunnelHealth(true);
  res.json({ ok: health.ok, health });
});

app.post('/api/companion/disconnect', (_req, res) => {
  for (const pending of companionState.pendingApprovals.values()) {
    pending.resolve({ approved: false, note: '用户已断开伴侣隧道' });
  }
  companionState.pendingApprovals.clear();
  companionState.revertSnapshots.clear();
  companionState.connected = false;
  companionState.tunnelUrl = '';
  companionState.token = '';
  companionState.workspace = null;
  companionState.health = { ok: false };
  clearEphemeralSession();
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
  persistEphemeralSession();
  broadcastCompanionState();
  res.json({ ok: true, state: getPublicCompanionState() });
});

app.post('/api/companion/events/clear', (_req, res) => {
  companionState.events = [];
  companionState.revertSnapshots.clear();
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
      persistEphemeralSession();
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

// 1-Click Revert for edit_file / write_file / write_files / delete_file events
app.post('/api/companion/revert/:eventId', async (req, res) => {
  try {
    const eventId = req.params.eventId;
    const snap = companionState.revertSnapshots.get(eventId);
    if (!snap || snap.entries.length === 0) {
      res.status(404).json({ error: '该操作没有可用的回滚快照（可能已回滚或超过历史上限）' });
      return;
    }
    for (const entry of snap.entries) {
      if (entry.existed) {
        await callActiveTunnelTool('write_file', {
          path: entry.filePath,
          content: entry.content,
        });
      } else {
        await callActiveTunnelTool('delete_file', { path: entry.filePath });
      }
    }
    companionState.revertSnapshots.delete(eventId);
    updateCompanionEvent(eventId, { canRevert: false, reverted: true });
    const primaryPath = snap.entries[0].filePath;
    pushCompanionEvent({
      id: companionId('ev'),
      toolName: snap.entries[0].existed ? 'revert_restore' : 'revert_delete',
      args: { path: primaryPath, count: snap.entries.length, revertedEventId: eventId },
      status: 'success',
      source: 'ui',
      startedAt: Date.now(),
      durationMs: 0,
      filePath: primaryPath,
      result: { count: snap.entries.length, path: primaryPath },
    });
    res.json({ ok: true, filePath: primaryPath });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Direct UI proxy (file tree, file preview, git inspect, manual streaming commands)
app.post('/api/companion/ui-tool', async (req, res) => {
  try {
    const body = (req.body || {}) as { tool?: string; args?: Record<string, unknown> };
    const tool = String(body.tool || '');
    if (!tool) {
      res.status(400).json({ error: '缺少 tool 名称' });
      return;
    }
    if (tool === 'run_command') {
      const eventId = companionId('ev');
      const processId = String(body.args?.processId || companionId('proc'));
      const startedAt = Date.now();
      const command = String(body.args?.command || '');
      pushCompanionEvent({
        id: eventId,
        toolName: 'run_command',
        args: { ...(body.args || {}), processId },
        status: 'running',
        source: 'ui',
        startedAt,
        command,
        processId,
        liveStdout: '',
        liveStderr: '',
      });
      try {
        const result = await streamActiveTunnelCommand(
          { ...(body.args || {}), processId },
          ({ processId: pid, stdout, stderr }) => {
            updateCompanionEvent(eventId, {
              processId: pid || processId,
              liveStdout: stdout,
              liveStderr: stderr,
            });
          }
        );
        const exitCode = typeof result.exitCode === 'number' ? result.exitCode : 0;
        updateCompanionEvent(eventId, {
          status: exitCode === 0 ? 'success' : 'error',
          result,
          liveStdout: String(result.stdout || ''),
          liveStderr: String(result.stderr || ''),
          durationMs: Date.now() - startedAt,
        });
        res.json({ ok: true, result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        updateCompanionEvent(eventId, {
          status: 'error',
          error: message,
          durationMs: Date.now() - startedAt,
        });
        res.status(400).json({ error: message });
      }
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

// Companion chat execution gate (enforces policy + live UI diff/command approval + streaming + revert snapshot)
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
    // v2.2+ returns previousContent inline (1 tunnel RTT instead of 2); fallback to pre-read for v2.1
    const useInlineSnap = supportsInlineRevertSnapshot(companionState.workspace?.version);
    const preSnap = useInlineSnap ? null : await capturePreWriteSnapshot(toolName, args);

    let result: Record<string, unknown>;
    let effectiveSnap: RevertSnapshot | null = preSnap;

    if (toolName === 'run_command') {
      const processId = String(args.processId || companionId('proc'));
      updateCompanionEvent(eventId, { processId, liveStdout: '', liveStderr: '' });
      result = await streamActiveTunnelCommand(
        { ...args, processId },
        ({ processId: pid, stdout, stderr }) => {
          updateCompanionEvent(eventId, {
            processId: pid || processId,
            liveStdout: stdout,
            liveStderr: stderr,
          });
        }
      );
    } else {
      const rawResult = await callActiveTunnelTool(toolName, args);
      const extracted = extractInlineRevertSnapshot(toolName, rawResult);
      result = extracted.sanitizedResult;
      if (extracted.snapshot) {
        effectiveSnap = extracted.snapshot;
      }
    }

    if (effectiveSnap) {
      storeRevertSnapshot(eventId, effectiveSnap);
    }

    const durationMs = Date.now() - startedAt;
    const exitCode = toolName === 'run_command' && typeof result.exitCode === 'number' ? result.exitCode : 0;
    updateCompanionEvent(eventId, {
      status: exitCode === 0 ? 'success' : 'error',
      result,
      liveStdout: toolName === 'run_command' ? String(result.stdout || '') : undefined,
      liveStderr: toolName === 'run_command' ? String(result.stderr || '') : undefined,
      canRevert: Boolean(effectiveSnap),
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
    process.env.DISABLE_HMR = 'true';
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false, ws: false },
      appType: 'spa',
    });
    // Prevent 1-year `immutable` disk cache entries from poisoning embedded iframe reloads
    // if a dev server restart interrupts an in-flight Vite pre-bundled dep transfer.
    app.use('/node_modules/.vite/deps', (_req, res, next) => {
      const origSetHeader = res.setHeader.bind(res);
      res.setHeader = ((name: string, value: number | string | readonly string[]) => {
        if (name.toLowerCase() === 'cache-control') {
          return origSetHeader(name, 'no-cache');
        }
        return origSetHeader(name, value);
      }) as typeof res.setHeader;
      next();
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
    console.log(`LocalBridge Companion Control Plane v2.1 running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
