export function getLocalBridgeScript(): string {
  return `#!/usr/bin/env node
/**
 * LocalBridge — Zero-Dependency Local Workspace Bridge & MCP Server
 * Node.js v20+ required. Binds strictly to 127.0.0.1.
 *
 * Usage:
 *   node local-bridge.mjs                  # Start immediately with current folder
 *   node local-bridge.mjs setup            # Interactive CLI permission & port wizard
 *   node local-bridge.mjs --port 4829 --root . --no-shell --read-only
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const args = process.argv.slice(2);
function getFlag(name, fallback) {
  const idx = args.indexOf(name);
  if (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith('--')) {
    return args[idx + 1];
  }
  return fallback;
}

const IS_INTERACTIVE_SETUP = args.includes('setup') || args.includes('--setup');

let PORT = Number(getFlag('--port', process.env.LOCALBRIDGE_PORT || '4829'));
let ROOT_INPUT = getFlag('--root', process.cwd());
let READ_ONLY = args.includes('--read-only') || process.env.LOCALBRIDGE_READ_ONLY === '1';
let NO_SHELL = READ_ONLY || args.includes('--no-shell') || process.env.LOCALBRIDGE_NO_SHELL === '1';
let TOKEN = getFlag('--token', process.env.LOCALBRIDGE_TOKEN || crypto.randomBytes(20).toString('hex'));

if (IS_INTERACTIVE_SETUP) {
  const rl = readline.createInterface({ input, output });
  try {
    console.log('');
    console.log('=== LocalBridge 交互式权限配置向导 ===');
    const dirAns = (await rl.question(\`1) 授权工作区目录 [默认当前目录 \${process.cwd()}]: \`)).trim();
    if (dirAns) ROOT_INPUT = dirAns;

    console.log('2) 请选择本机权限级别:');
    console.log('   [1] 只读模式 (仅允许读取/搜索/git diff，禁止写文件和执行命令)');
    console.log('   [2] 读写无命令模式 (允许读写改代码，禁止执行任何终端命令)');
    console.log('   [3] 完整模式 (允许读写与终端命令，执行前由前端审批或白名单控制)');
    const permAns = (await rl.question('   请输入选项编号 [默认 3]: ')).trim();
    if (permAns === '1') {
      READ_ONLY = true;
      NO_SHELL = true;
    } else if (permAns === '2') {
      READ_ONLY = false;
      NO_SHELL = true;
    } else {
      READ_ONLY = false;
      NO_SHELL = false;
    }

    const portAns = (await rl.question(\`3) 监听端口 (仅 127.0.0.1) [默认 \${PORT}]: \`)).trim();
    if (portAns && !Number.isNaN(Number(portAns))) {
      PORT = Number(portAns);
    }
  } finally {
    rl.close();
  }
}

const ROOT = fs.realpathSync(path.resolve(ROOT_INPUT));

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.nuxt',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  '.turbo',
  '.cache',
]);

const MAX_READ_BYTES = 512 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_TIMEOUT_MS = 120_000;
const activeProcesses = new Map();

function normalizeRel(p) {
  return p.split(path.sep).join('/');
}

async function resolveSafePath(relPath = '.', { mustExist = false } = {}) {
  const cleaned = typeof relPath === 'string' && relPath.trim() !== '' ? relPath.trim() : '.';
  const candidate = path.resolve(ROOT, cleaned);
  if (candidate !== ROOT && !candidate.startsWith(ROOT + path.sep)) {
    throw new Error('路径越界：仅允许访问授权的工作区目录内部文件');
  }

  if (fs.existsSync(candidate)) {
    const real = await fsp.realpath(candidate);
    if (real !== ROOT && !real.startsWith(ROOT + path.sep)) {
      throw new Error('检测到指向工作区外部的软链接，已拦截');
    }
    return real;
  }

  if (mustExist) {
    throw new Error(\`路径不存在: \${cleaned}\`);
  }

  // Validate nearest existing ancestor against symlink escapes
  let probe = path.dirname(candidate);
  while (!fs.existsSync(probe) && probe !== path.dirname(probe)) {
    probe = path.dirname(probe);
  }
  const realAncestor = await fsp.realpath(probe);
  if (realAncestor !== ROOT && !realAncestor.startsWith(ROOT + path.sep)) {
    throw new Error('父目录软链接越界，已拦截');
  }
  return candidate;
}

function isBinaryBuffer(buf) {
  const sampleLen = Math.min(buf.length, 4096);
  for (let i = 0; i < sampleLen; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

async function runSimpleProcess(cmd, cmdArgs, cwd, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, {
      cwd,
      env: { ...process.env, CI: 'true', GIT_PAGER: 'cat', PAGER: 'cat' },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: -1, stdout, stderr: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr });
    });
  });
}

async function listDirectory(relPath = '.') {
  const dir = await resolveSafePath(relPath, { mustExist: true });
  const stat = await fsp.stat(dir);
  if (!stat.isDirectory()) {
    throw new Error(\`不是目录: \${relPath}\`);
  }
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const items = [];
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    let size = undefined;
    if (entry.isFile()) {
      try {
        const s = await fsp.stat(full);
        size = s.size;
      } catch {}
    }
    items.push({
      name: entry.name,
      path: normalizeRel(path.relative(ROOT, full)),
      type: entry.isDirectory() ? 'dir' : 'file',
      size,
    });
  }
  items.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return {
    path: normalizeRel(path.relative(ROOT, dir)) || '.',
    entries: items,
  };
}

async function buildTreeSummary(dir, depth = 0, maxDepth = 2) {
  if (depth > maxDepth) return [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    if (result.length >= 60) break;
    const full = path.join(dir, entry.name);
    const rel = normalizeRel(path.relative(ROOT, full));
    if (entry.isDirectory()) {
      const children = depth < maxDepth ? await buildTreeSummary(full, depth + 1, maxDepth) : [];
      result.push({ name: entry.name, path: rel, type: 'dir', children });
    } else {
      result.push({ name: entry.name, path: rel, type: 'file' });
    }
  }
  result.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return result;
}

async function inspectWorkspace() {
  const tree = await buildTreeSummary(ROOT, 0, 2);
  const stack = [];
  let scripts = {};

  const pkgPath = path.join(ROOT, 'package.json');
  if (fs.existsSync(pkgPath)) {
    stack.push('Node.js');
    try {
      const pkg = JSON.parse(await fsp.readFile(pkgPath, 'utf8'));
      scripts = pkg.scripts || {};
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      if (deps.typescript) stack.push('TypeScript');
      if (deps.react) stack.push('React');
      if (deps.next) stack.push('Next.js');
      if (deps.vue) stack.push('Vue');
      if (deps.vite) stack.push('Vite');
      if (deps.express || deps.fastify || deps.hono) stack.push('Node Server');
      if (deps.tailwindcss) stack.push('Tailwind CSS');
    } catch {}
  }
  if (fs.existsSync(path.join(ROOT, 'pyproject.toml')) || fs.existsSync(path.join(ROOT, 'requirements.txt'))) {
    stack.push('Python');
  }
  if (fs.existsSync(path.join(ROOT, 'Cargo.toml'))) stack.push('Rust');
  if (fs.existsSync(path.join(ROOT, 'go.mod'))) stack.push('Go');

  let branch = undefined;
  let dirtyCount = 0;
  let gitStatusShort = '';
  if (fs.existsSync(path.join(ROOT, '.git'))) {
    const gitRes = await runSimpleProcess('git', ['status', '--short', '-b'], ROOT, 8000);
    if (gitRes.exitCode === 0) {
      const lines = gitRes.stdout.trim().split(/\\r?\\n/).filter(Boolean);
      if (lines[0] && lines[0].startsWith('## ')) {
        branch = lines[0].slice(3).split('...')[0];
      }
      dirtyCount = Math.max(0, lines.length - 1);
      gitStatusShort = lines.slice(0, 30).join('\\n');
    }
  }

  return {
    name: path.basename(ROOT),
    rootPath: ROOT,
    noShell: NO_SHELL,
    stack,
    scripts,
    branch,
    dirtyCount,
    gitStatusShort,
    tree,
  };
}

async function readFileTool({ path: relPath, startLine, endLine }) {
  if (!relPath) throw new Error('缺少参数: path');
  const full = await resolveSafePath(relPath, { mustExist: true });
  const stat = await fsp.stat(full);
  if (!stat.isFile()) throw new Error(\`路径不是文件: \${relPath}\`);
  if (stat.size > MAX_READ_BYTES * 4) {
    throw new Error(\`文件过大 (\${Math.round(stat.size / 1024)}KB)，请检查是否为二进制或构建产物\`);
  }
  const buf = await fsp.readFile(full);
  if (isBinaryBuffer(buf)) {
    throw new Error(\`检测到二进制文件，无法以文本方式读取: \${relPath}\`);
  }
  const raw = buf.toString('utf8');
  const lines = raw.split(/\\r?\\n/);
  const totalLines = lines.length;
  const start = Math.max(1, Number(startLine) || 1);
  const defaultEnd = Math.min(totalLines, start + 499);
  const end = Math.min(totalLines, Number(endLine) || defaultEnd);
  const slice = lines.slice(start - 1, end);
  let content = slice.join('\\n');
  let truncated = end < totalLines;
  if (content.length > MAX_READ_BYTES) {
    content = content.slice(0, MAX_READ_BYTES);
    truncated = true;
  }
  return {
    path: normalizeRel(path.relative(ROOT, full)),
    startLine: start,
    endLine: end,
    totalLines,
    truncated,
    content,
  };
}

async function searchFilesTool({ query, dir = '.', maxResults = 60 }) {
  if (!query || typeof query !== 'string') throw new Error('缺少搜索关键字: query');
  const base = await resolveSafePath(dir, { mustExist: true });
  const limit = Math.min(100, Math.max(1, Number(maxResults) || 60));
  const matches = [];
  const lowerQuery = query.toLowerCase();
  let regex = null;
  try {
    regex = new RegExp(query, 'i');
  } catch {
    regex = null;
  }

  async function walk(currentDir) {
    if (matches.length >= limit) return;
    let entries;
    try {
      entries = await fsp.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (matches.length >= limit) return;
      if (IGNORED_DIRS.has(entry.name)) continue;
      const full = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        try {
          const stat = await fsp.stat(full);
          if (stat.size > 256 * 1024) continue;
          const buf = await fsp.readFile(full);
          if (isBinaryBuffer(buf)) continue;
          const text = buf.toString('utf8');
          const lines = text.split(/\\r?\\n/);
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const hit = regex ? regex.test(line) : line.toLowerCase().includes(lowerQuery);
            if (hit) {
              matches.push({
                path: normalizeRel(path.relative(ROOT, full)),
                line: i + 1,
                preview: line.trim().slice(0, 220),
              });
              if (matches.length >= limit) return;
            }
          }
        } catch {}
      }
    }
  }

  await walk(base);
  return { query, count: matches.length, truncated: matches.length >= limit, matches };
}

async function editFileTool({ path: relPath, oldString, newString, replaceAll = false }) {
  if (READ_ONLY) throw new Error('本机 Bridge 已以 --read-only 只读模式启动，拒绝修改文件');
  if (!relPath) throw new Error('缺少参数: path');
  if (typeof oldString !== 'string' || oldString.length === 0) {
    throw new Error('oldString 不能为空');
  }
  if (typeof newString !== 'string') throw new Error('缺少参数: newString');

  const full = await resolveSafePath(relPath, { mustExist: true });
  const before = await fsp.readFile(full, 'utf8');
  const occurrences = before.split(oldString).length - 1;
  if (occurrences === 0) {
    throw new Error(\`未在 \${relPath} 中找到匹配的 oldString，请先 read_file 确认最新内容\`);
  }
  if (occurrences > 1 && !replaceAll) {
    throw new Error(\`在 \${relPath} 中找到 \${occurrences} 处匹配，请提供更精确的上下文或设置 replaceAll=true\`);
  }
  const after = replaceAll ? before.split(oldString).join(newString) : before.replace(oldString, newString);
  await fsp.writeFile(full, after, 'utf8');
  return {
    path: normalizeRel(path.relative(ROOT, full)),
    replacements: replaceAll ? occurrences : 1,
    totalLines: after.split(/\\r?\\n/).length,
  };
}

async function writeFileTool({ path: relPath, content }) {
  if (READ_ONLY) throw new Error('本机 Bridge 已以 --read-only 只读模式启动，拒绝写入文件');
  if (!relPath) throw new Error('缺少参数: path');
  if (typeof content !== 'string') throw new Error('缺少参数: content');
  const full = await resolveSafePath(relPath, { mustExist: false });
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, content, 'utf8');
  return {
    path: normalizeRel(path.relative(ROOT, full)),
    bytes: Buffer.byteLength(content, 'utf8'),
    totalLines: content.split(/\\r?\\n/).length,
  };
}

async function deleteFileTool({ path: relPath }) {
  if (READ_ONLY) throw new Error('本机 Bridge 已以 --read-only 只读模式启动，拒绝删除文件');
  if (!relPath) throw new Error('缺少参数: path');
  const full = await resolveSafePath(relPath, { mustExist: true });
  const stat = await fsp.stat(full);
  if (stat.isDirectory()) {
    throw new Error('安全限制：不支持通过 delete_file 直接删除整个目录');
  }
  await fsp.unlink(full);
  return { deleted: normalizeRel(path.relative(ROOT, full)) };
}

async function createDirectoryTool({ path: relPath }) {
  if (READ_ONLY) throw new Error('本机 Bridge 已以 --read-only 只读模式启动，拒绝新建目录');
  if (!relPath) throw new Error('缺少参数: path');
  const full = await resolveSafePath(relPath, { mustExist: false });
  await fsp.mkdir(full, { recursive: true });
  return { created: normalizeRel(path.relative(ROOT, full)) };
}

async function movePathTool({ from, to }) {
  if (READ_ONLY) throw new Error('本机 Bridge 已以 --read-only 只读模式启动，拒绝移动或重命名路径');
  if (!from || !to) throw new Error('缺少参数: from 或 to');
  const src = await resolveSafePath(from, { mustExist: true });
  const dst = await resolveSafePath(to, { mustExist: false });
  if (src === ROOT) throw new Error('不能移动工作区根目录本身');
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  await fsp.rename(src, dst);
  return {
    from: normalizeRel(path.relative(ROOT, src)),
    to: normalizeRel(path.relative(ROOT, dst)),
  };
}

async function gitDiffTool({ path: relPath, staged = false } = {}) {
  const gitArgs = ['diff'];
  if (staged) gitArgs.push('--staged');
  if (relPath) {
    await resolveSafePath(relPath, { mustExist: false });
    gitArgs.push('--', relPath);
  }
  const diffRes = await runSimpleProcess('git', gitArgs, ROOT, 15000);
  const statusRes = await runSimpleProcess('git', ['status', '--short', '-b'], ROOT, 8000);
  return {
    status: statusRes.stdout.trim(),
    diff: diffRes.stdout || '',
    stderr: diffRes.stderr || '',
    exitCode: diffRes.exitCode,
  };
}

async function runCommandTool({ command, cwd = '.', timeoutMs = 30000, processId }) {
  if (NO_SHELL) {
    throw new Error('本机 Bridge 已以 --no-shell 安全模式启动，拒绝执行终端命令');
  }
  if (!command || typeof command !== 'string') {
    throw new Error('缺少参数: command');
  }
  const workDir = await resolveSafePath(cwd, { mustExist: true });
  const clampedTimeout = Math.min(MAX_TIMEOUT_MS, Math.max(1000, Number(timeoutMs) || 30000));
  const pidKey = processId || crypto.randomUUID();
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: workDir,
      shell: true,
      env: { ...process.env, CI: 'true', FORCE_COLOR: '0', PAGER: 'cat', GIT_PAGER: 'cat' },
    });

    activeProcesses.set(pidKey, child);
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
      }, 2000);
    }, clampedTimeout);

    child.stdout.on('data', (chunk) => {
      const str = chunk.toString('utf8');
      if (stdout.length + str.length <= MAX_OUTPUT_BYTES) {
        stdout += str;
      } else {
        stdout += str.slice(0, Math.max(0, MAX_OUTPUT_BYTES - stdout.length));
        truncated = true;
      }
    });

    child.stderr.on('data', (chunk) => {
      const str = chunk.toString('utf8');
      if (stderr.length + str.length <= MAX_OUTPUT_BYTES) {
        stderr += str;
      } else {
        stderr += str.slice(0, Math.max(0, MAX_OUTPUT_BYTES - stderr.length));
        truncated = true;
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      activeProcesses.delete(pidKey);
      resolve({
        processId: pidKey,
        exitCode: -1,
        stdout,
        stderr: stderr ? \`\${stderr}\\n\${err.message}\` : err.message,
        timedOut,
        truncated,
        durationMs: Date.now() - startedAt,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      activeProcesses.delete(pidKey);
      resolve({
        processId: pidKey,
        exitCode: code,
        stdout,
        stderr,
        timedOut,
        truncated,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

const TOOL_HANDLERS = {
  inspect_workspace: () => inspectWorkspace(),
  list_directory: (a) => listDirectory(a?.path || '.'),
  read_file: (a) => readFileTool(a || {}),
  search_files: (a) => searchFilesTool(a || {}),
  edit_file: (a) => editFileTool(a || {}),
  write_file: (a) => writeFileTool(a || {}),
  delete_file: (a) => deleteFileTool(a || {}),
  create_directory: (a) => createDirectoryTool(a || {}),
  move_path: (a) => movePathTool(a || {}),
  git_diff: (a) => gitDiffTool(a || {}),
  run_command: (a) => runCommandTool(a || {}),
};

const MCP_TOOLS_MANIFEST = [
  {
    name: 'inspect_workspace',
    description: 'Inspect repository overview, detected tech stack, scripts, git status, and top-level directory tree.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_directory',
    description: 'List files and folders inside a relative workspace directory.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Relative path from workspace root' } },
    },
  },
  {
    name: 'read_file',
    description: 'Read a text file with optional 1-indexed startLine and endLine.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        startLine: { type: 'integer' },
        endLine: { type: 'integer' },
      },
      required: ['path'],
    },
  },
  {
    name: 'search_files',
    description: 'Search text or regex across workspace files.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        dir: { type: 'string' },
        maxResults: { type: 'integer' },
      },
      required: ['query'],
    },
  },
  ...(READ_ONLY
    ? []
    : [
        {
          name: 'edit_file',
          description: 'Replace an exact unique substring in an existing file.',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              oldString: { type: 'string' },
              newString: { type: 'string' },
              replaceAll: { type: 'boolean' },
            },
            required: ['path', 'oldString', 'newString'],
          },
        },
        {
          name: 'write_file',
          description: 'Create or overwrite a file inside the workspace.',
          inputSchema: {
            type: 'object',
            properties: { path: { type: 'string' }, content: { type: 'string' } },
            required: ['path', 'content'],
          },
        },
        {
          name: 'delete_file',
          description: 'Delete a single file inside the workspace.',
          inputSchema: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
        {
          name: 'create_directory',
          description: 'Create a directory (and missing parent directories) inside the workspace.',
          inputSchema: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
        {
          name: 'move_path',
          description: 'Move or rename a file or directory inside the workspace.',
          inputSchema: {
            type: 'object',
            properties: {
              from: { type: 'string' },
              to: { type: 'string' },
            },
            required: ['from', 'to'],
          },
        },
      ]),
  {
    name: 'git_diff',
    description: 'Return git status and git diff for the repository or a specific file.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, staged: { type: 'boolean' } },
    },
  },
  ...(NO_SHELL
    ? []
    : [
        {
          name: 'run_command',
          description: 'Execute a shell command in the workspace with timeout and output limits.',
          inputSchema: {
            type: 'object',
            properties: {
              command: { type: 'string' },
              cwd: { type: 'string' },
              timeoutMs: { type: 'integer' },
            },
            required: ['command'],
          },
        },
      ]),
];

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Bridge-Token, Mcp-Session-Id'
  );
  // Required by Chrome Private Network Access (HTTPS -> 127.0.0.1)
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Access-Control-Max-Age', '600');
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk.toString('utf8');
      if (raw.length > 4 * 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', reject);
  });
}

function isAuthorized(req, urlToken) {
  const headerToken = req.headers['x-bridge-token'];
  const authHeader = req.headers['authorization'];
  const bearer =
    typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : undefined;
  const presented = headerToken || bearer || urlToken;
  if (typeof presented !== 'string') return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const server = http.createServer(async (req, res) => {
  setCorsHeaders(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url || '/', \`http://127.0.0.1:\${PORT}\`);
  const pathname = parsedUrl.pathname;

  if (req.method === 'GET' && pathname === '/health') {
    return sendJson(res, 200, {
      ok: true,
      bridge: 'localbridge',
      version: '1.0.0',
      readOnly: READ_ONLY,
      noShell: NO_SHELL,
    });
  }

  // Standard MCP JSON-RPC 2.0 endpoint (/mcp or /mcp/<token>)
  if (req.method === 'POST' && (pathname === '/mcp' || pathname.startsWith('/mcp/'))) {
    const urlToken = pathname.startsWith('/mcp/') ? pathname.slice(5) : undefined;
    if (!isAuthorized(req, urlToken)) {
      return sendJson(res, 401, {
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unauthorized: invalid or missing bridge token' },
        id: null,
      });
    }
    try {
      const rpc = await readJsonBody(req);
      const { id = null, method, params = {} } = rpc;

      if (method === 'initialize') {
        return sendJson(res, 200, {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'localbridge-mcp', version: '1.0.0' },
          },
        });
      }
      if (method === 'notifications/initialized') {
        res.writeHead(204);
        res.end();
        return;
      }
      if (method === 'tools/list') {
        return sendJson(res, 200, {
          jsonrpc: '2.0',
          id,
          result: { tools: MCP_TOOLS_MANIFEST },
        });
      }
      if (method === 'tools/call') {
        const toolName = params?.name;
        const toolArgs = params?.arguments || {};
        const handler = TOOL_HANDLERS[toolName];
        if (!handler) {
          return sendJson(res, 200, {
            jsonrpc: '2.0',
            id,
            result: {
              isError: true,
              content: [{ type: 'text', text: \`Unknown tool: \${toolName}\` }],
            },
          });
        }
        try {
          const output = await handler(toolArgs);
          return sendJson(res, 200, {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
            },
          });
        } catch (err) {
          return sendJson(res, 200, {
            jsonrpc: '2.0',
            id,
            result: {
              isError: true,
              content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
            },
          });
        }
      }
      return sendJson(res, 200, {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: \`Method not found: \${method}\` },
      });
    } catch (err) {
      return sendJson(res, 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  // Web Console Bridge API
  if (!isAuthorized(req)) {
    return sendJson(res, 401, { ok: false, error: '鉴权失败：请检查 X-Bridge-Token 是否与终端中显示的一致' });
  }

  if (req.method === 'POST' && pathname === '/api/kill') {
    try {
      const body = await readJsonBody(req);
      const child = activeProcesses.get(body.processId);
      if (child) {
        try { child.kill('SIGTERM'); } catch {}
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch {}
        }, 1200);
        activeProcesses.delete(body.processId);
        return sendJson(res, 200, { ok: true, killed: true });
      }
      return sendJson(res, 200, { ok: true, killed: false });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (req.method === 'POST' && pathname === '/api/tool') {
    try {
      const body = await readJsonBody(req);
      const { name, args: toolArgs } = body;
      const handler = TOOL_HANDLERS[name];
      if (!handler) {
        return sendJson(res, 400, { ok: false, error: \`不支持的工具: \${name}\` });
      }
      const result = await handler(toolArgs || {});
      return sendJson(res, 200, { ok: true, result });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return sendJson(res, 404, { ok: false, error: 'Not Found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('============================================================');
  console.log('  LocalBridge 本地仓库代理 & MCP 服务已启动');
  console.log('============================================================');
  console.log(\`  工作区目录 : \${ROOT}\`);
  console.log(\`  本机地址   : http://127.0.0.1:\${PORT}\`);
  console.log(\`  安全 Token : \${TOKEN}\`);
  console.log(\`  权限模式   : \${READ_ONLY ? '只读模式 (--read-only)' : NO_SHELL ? '读写禁命令 (--no-shell)' : '完整模式 (由前端审批/白名单控制)'}\`);
  console.log(\`  MCP 端点   : http://127.0.0.1:\${PORT}/mcp\`);
  console.log('------------------------------------------------------------');
  console.log('  提示: 请将上方地址和 Token 复制到浏览器 LocalBridge 控制台连接。');
  console.log('  仅监听 127.0.0.1，不会暴露到公网。按 Ctrl+C 停止服务。');
  console.log('============================================================');
  console.log('');
});
`;
}
