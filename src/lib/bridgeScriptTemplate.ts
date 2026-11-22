export function getLocalBridgeScript(): string {
  return `#!/usr/bin/env node
/**
 * LocalBridge v2.2 — 零依赖本地工作区桥接与隧道伴侣服务（支持实时流式终端 + CRLF 自适应编辑 + 批量原子写 + MCP JSON-RPC 2.0）
 * 运行要求: Node.js v20+
 *
 * 推荐启动方式（单命令同时启动本地桥接 + 公网隧道，自动打印一键配对串）:
 *   node local-bridge.mjs --ngrok --root "你的项目目录"
 *   node local-bridge.mjs --cloudflared --root "你的项目目录"
 *
 * 交互式向导（首次使用或动态切换目录推荐）:
 *   node local-bridge.mjs setup
 *
 * 其他参数:
 *   --root <dir>      限定可访问的根目录（默认当前目录）
 *   --port <num>      本机监听端口（默认 4829，严格绑定 127.0.0.1）
 *   --token <str>     固定访问令牌（默认每次启动随机生成 48 位密钥）
 *   --ngrok           自动拉起 ngrok http <port> 并输出一键配对串
 *   --cloudflared     自动拉起 cloudflared 快速隧道并输出一键配对串
 *   --read-only       硬只读模式（物理禁止写入、删除、改名与命令）
 *   --no-shell        禁用终端命令执行（仅允许文件读写与只读 Git）
 *   --allow-secrets   关闭默认敏感文件拦截（默认禁止读取 .env / 私钥 / *.pem / *.key）
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { spawn, execFileSync } from 'node:child_process';

const VERSION = '2.2.0';

function parseArgs(argv) {
  const args = {
    mode: 'run',
    root: '',
    port: 4829,
    token: '',
    tunnel: '',
    noShell: false,
    readOnly: false,
    allowSecrets: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === 'setup' || a === '--setup') args.mode = 'setup';
    else if (a === '--root' && argv[i + 1]) args.root = argv[++i];
    else if (a === '--port' && argv[i + 1]) args.port = Number(argv[++i]) || 4829;
    else if (a === '--token' && argv[i + 1]) args.token = argv[++i];
    else if (a === '--ngrok') args.tunnel = 'ngrok';
    else if (a === '--cloudflared') args.tunnel = 'cloudflared';
    else if (a === '--tunnel' && argv[i + 1]) args.tunnel = String(argv[++i]).toLowerCase();
    else if (a === '--no-shell') args.noShell = true;
    else if (a === '--read-only') args.readOnly = true;
    else if (a === '--allow-secrets') args.allowSecrets = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

const CLI = parseArgs(process.argv.slice(2));
if (CLI.help) {
  console.log(\`LocalBridge v\${VERSION} — 零依赖本地工作区桥接与隧道伴侣

用法:
  node local-bridge.mjs --ngrok --root "你的项目目录"   单命令启动桥接 + ngrok 并生成配对串
  node local-bridge.mjs --cloudflared --root "目录"    单命令启动桥接 + cloudflared
  node local-bridge.mjs setup                          交互式向导（自选目录、权限与隧道）
  node local-bridge.mjs [选项]                         仅启动本机 127.0.0.1 服务

选项:
  --root <dir>      限定可访问的根目录（默认当前目录）
  --port <num>      监听端口（默认 4829，严格绑定 127.0.0.1）
  --token <str>     固定访问 Token（默认每次随机生成）
  --ngrok           自动启动 ngrok 并读取公网地址
  --cloudflared     自动启动 cloudflared 临时隧道
  --read-only       只读模式（物理禁止写入、删除、改名与命令）
  --no-shell        禁用 run_command（保留文件读写与只读 Git）
  --allow-secrets   关闭默认敏感文件拦截（不推荐）
\`);
  process.exit(0);
}

async function runSetupWizard(initial) {
  const rl = readline.createInterface({ input, output });
  try {
    console.log('');
    console.log(\`LocalBridge v\${VERSION} 交互式启动向导\`);
    console.log('------------------------------------------------------------');
    const cwd = process.cwd();
    const rawRoot = (await rl.question(\`1) 要授权的本地项目目录（直接回车使用当前目录 \${cwd}）:\\n   > \`)).trim();
    const chosenRoot = rawRoot ? rawRoot.replace(/^["']|["']$/g, '') : cwd;
    if (!fsSync.existsSync(chosenRoot) || !fsSync.statSync(chosenRoot).isDirectory()) {
      console.error(\`目录不存在或不是文件夹: \${chosenRoot}\`);
      process.exit(1);
    }

    const rawPerm = (await rl.question(
      '2) 权限级别 [1=完整读写+命令(默认) / 2=仅读写禁命令 / 3=严格只读]: '
    )).trim();
    let readOnly = initial.readOnly;
    let noShell = initial.noShell;
    if (rawPerm === '2') { noShell = true; readOnly = false; }
    else if (rawPerm === '3') { readOnly = true; noShell = true; }

    const rawTunnel = (await rl.question(
      '3) 自动启动隧道 [1=ngrok(推荐) / 2=cloudflared / 3=不启动(我手动开)]: '
    )).trim();
    let tunnel = initial.tunnel;
    if (rawTunnel === '' || rawTunnel === '1') tunnel = 'ngrok';
    else if (rawTunnel === '2') tunnel = 'cloudflared';
    else if (rawTunnel === '3') tunnel = '';

    const rawPort = (await rl.question(\`4) 本机监听端口（直接回车默认 \${initial.port}）: \`)).trim();
    const port = rawPort ? Number(rawPort) || initial.port : initial.port;

    const rawToken = (await rl.question('5) 安全 Token（直接回车自动生成高强度随机密钥）: ')).trim();
    const token = rawToken || initial.token || crypto.randomBytes(24).toString('hex');

    return { ...initial, root: chosenRoot, readOnly, noShell, tunnel, port, token };
  } finally {
    rl.close();
  }
}

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '.svelte-kit',
  '__pycache__', '.venv', 'venv', 'target', 'vendor', '.cache', '.turbo', 'coverage',
  '.idea', '.vs', 'out',
]);

const SAFE_ENV_EXAMPLES = new Set([
  '.env.example',
  '.env.sample',
  '.env.template',
  '.env.dist',
]);

const SENSITIVE_BASENAMES = new Set([
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
  '.npmrc',
  '.netrc',
  '.pypirc',
  'credentials.json',
  'secrets.json',
  'secrets.yaml',
  'secrets.yml',
]);

const SENSITIVE_EXTENSIONS = new Set([
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.jks',
  '.keystore',
]);

const MAX_READ_BYTES = 1024 * 1024 * 2;
const activeProcesses = new Map();
let ROOT_REAL = '';
let ACTIVE_TOKEN = '';
let ACTIVE_PORT = 4829;
let ACTIVE_NO_SHELL = false;
let ACTIVE_READ_ONLY = false;
let ACTIVE_ALLOW_SECRETS = false;
let tunnelChild = null;

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function isSensitiveRelPath(relPosix) {
  if (ACTIVE_ALLOW_SECRETS) return false;
  const normalized = String(relPosix || '').replace(/^\\/+/, '').toLowerCase();
  if (!normalized || normalized === '.') return false;
  const parts = normalized.split('/');
  const base = parts[parts.length - 1];
  if (parts.includes('.ssh') || parts.includes('.aws') || parts.includes('.gnupg')) {
    return true;
  }
  if (base === '.env' || (base.startsWith('.env.') && !SAFE_ENV_EXAMPLES.has(base))) {
    return true;
  }
  if (SENSITIVE_BASENAMES.has(base)) return true;
  if (base.startsWith('service-account') && base.endsWith('.json')) return true;
  const ext = path.posix.extname(base);
  if (SENSITIVE_EXTENSIONS.has(ext)) return true;
  return false;
}

function assertNotSensitive(absPath) {
  const rel = toPosix(path.relative(ROOT_REAL, absPath));
  if (isSensitiveRelPath(rel)) {
    throw new Error(\`敏感文件保护：已拦截对 "\${rel}" 的访问（如需临时放行请使用 --allow-secrets 启动）\`);
  }
}

async function resolveSafePath(relPath = '.', { allowNonExistent = false } = {}) {
  const cleaned = String(relPath || '.').replace(/^\\/+/, '');
  const candidate = path.resolve(ROOT_REAL, cleaned);
  if (candidate !== ROOT_REAL && !candidate.startsWith(ROOT_REAL + path.sep)) {
    throw new Error(\`路径越界，已拦截: \${relPath}\`);
  }
  try {
    const real = await fs.realpath(candidate);
    if (real !== ROOT_REAL && !real.startsWith(ROOT_REAL + path.sep)) {
      throw new Error(\`软链接指向工作区外部，已拦截: \${relPath}\`);
    }
    return real;
  } catch (err) {
    if (allowNonExistent && err && err.code === 'ENOENT') {
      let ancestor = path.dirname(candidate);
      while (ancestor && ancestor !== path.dirname(ancestor)) {
        if (fsSync.existsSync(ancestor)) {
          const ancestorReal = await fs.realpath(ancestor);
          if (ancestorReal !== ROOT_REAL && !ancestorReal.startsWith(ROOT_REAL + path.sep)) {
            throw new Error(\`目标父目录指向工作区外部，已拦截: \${relPath}\`);
          }
          break;
        }
        ancestor = path.dirname(ancestor);
      }
      return candidate;
    }
    throw err;
  }
}

function globToRegex(glob) {
  const escaped = String(glob || '')
    .trim()
    .replace(/[.+^$()|[\\]\\\\]/g, '\\\\$&')
    .replace(/\\*\\*/g, '§§DOUBLESTAR§§')
    .replace(/\\*/g, '[^/]*')
    .replace(/\\?/g, '[^/]')
    .replace(/§§DOUBLESTAR§§/g, '.*');
  return new RegExp('^' + escaped + '$', 'i');
}

function matchesIncludeFilter(relPosix, include) {
  if (!include || !String(include).trim()) return true;
  const patterns = String(include)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (patterns.length === 0) return true;
  const baseName = path.posix.basename(relPosix);
  return patterns.some((pat) => {
    const normalized = pat.includes('/') ? pat : pat.startsWith('.') ? '*' + pat : pat;
    const re = globToRegex(normalized);
    return pat.includes('/') ? re.test(relPosix) : re.test(baseName) || re.test(relPosix);
  });
}

function runGitSafe(cwdAbs, gitArgs, maxBuffer = 4 * 1024 * 1024) {
  return execFileSync('git', gitArgs, {
    cwd: cwdAbs,
    encoding: 'utf8',
    timeout: 12000,
    maxBuffer,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function probeGitRepo(dirAbs, relPath) {
  if (!fsSync.existsSync(path.join(dirAbs, '.git'))) return null;
  try {
    const branch = runGitSafe(dirAbs, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    const statusRaw = runGitSafe(dirAbs, ['status', '--porcelain']).trim();
    const dirtyCount = statusRaw ? statusRaw.split(/\\r?\\n/).filter(Boolean).length : 0;
    return {
      path: relPath,
      name: relPath === '.' ? path.basename(ROOT_REAL) : path.basename(dirAbs),
      branch,
      dirtyCount,
    };
  } catch {
    return {
      path: relPath,
      name: relPath === '.' ? path.basename(ROOT_REAL) : path.basename(dirAbs),
    };
  }
}

async function discoverGitRepos() {
  const repos = [];
  const rootRepo = probeGitRepo(ROOT_REAL, '.');
  if (rootRepo) repos.push(rootRepo);
  try {
    const entries = await fs.readdir(ROOT_REAL, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() || IGNORED_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      const subAbs = path.join(ROOT_REAL, e.name);
      const found = probeGitRepo(subAbs, e.name);
      if (found) repos.push(found);
    }
  } catch {}
  return repos;
}

async function buildTree(dirAbs, relPrefix = '', depth = 0, maxDepth = 2, budget = { count: 0, max: 350 }) {
  if (depth > maxDepth || budget.count >= budget.max) return [];
  const entries = await fs.readdir(dirAbs, { withFileTypes: true });
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const nodes = [];
  for (const e of entries) {
    if (budget.count >= budget.max) break;
    if (e.isDirectory() && IGNORED_DIRS.has(e.name)) continue;
    const rel = relPrefix ? \`\${relPrefix}/\${e.name}\` : e.name;
    budget.count++;
    if (e.isDirectory()) {
      const children = depth < maxDepth
        ? await buildTree(path.join(dirAbs, e.name), rel, depth + 1, maxDepth, budget)
        : [];
      nodes.push({ name: e.name, path: rel, type: 'dir', children });
    } else {
      nodes.push({ name: e.name, path: rel, type: 'file' });
    }
  }
  return nodes;
}

function assertWritable(toolName) {
  if (ACTIVE_READ_ONLY) {
    throw new Error(\`LocalBridge 处于 --read-only 硬只读模式，已拦截写入操作: \${toolName}\`);
  }
}

function terminateChildTree(child) {
  if (!child || child.killed) return;
  if (process.platform === 'win32' && child.pid) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      return;
    } catch {}
  }
  try { child.kill('SIGTERM'); } catch {}
}

const TOOL_SCHEMAS = [
  {
    name: 'inspect_workspace',
    description: '获取工作区概览、技术栈、多子仓库 Git 状态和可配置深度的目录树',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '可选相对目录路径，默认 .' },
        maxDepth: { type: 'number', description: '目录树展开深度（1-4，默认 2）' },
      },
    },
  },
  {
    name: 'list_directory',
    description: '列出指定目录下的文件与子目录',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  },
  {
    name: 'find_files',
    description: '按文件名模式（glob）或扩展名快速查找工作区内的文件路径',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        pattern: { type: 'string', description: '如 **/*.hpp 或 *layer*' },
        extensions: { type: 'array', items: { type: 'string' } },
        maxResults: { type: 'number' },
      },
    },
  },
  {
    name: 'read_file',
    description: '按行范围读取本地文本文件内容',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        startLine: { type: 'number' },
        endLine: { type: 'number' },
      },
      required: ['path'],
    },
  },
  {
    name: 'read_files',
    description: '一次请求批量读取多个文件（支持各自指定行范围）',
    inputSchema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              startLine: { type: 'number' },
              endLine: { type: 'number' },
            },
            required: ['path'],
          },
        },
      },
      required: ['files'],
    },
  },
  {
    name: 'search_files',
    description: '在工作区源码中搜索关键词或正则（支持文件扩展名过滤与上下文行）',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        path: { type: 'string' },
        include: { type: 'string', description: '逗号分隔的过滤模式，如 *.cpp,*.hpp' },
        regex: { type: 'boolean' },
        caseSensitive: { type: 'boolean' },
        contextLines: { type: 'number' },
        maxResults: { type: 'number' },
      },
      required: ['query'],
    },
  },
  {
    name: 'git_inspect',
    description: '只读查询指定目录（含多子仓库）的 Git status / diff / staged_diff / log / branches / show',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: '相对根目录的子仓库路径，默认 .' },
        action: { type: 'string', enum: ['status', 'diff', 'staged_diff', 'log', 'branches', 'show'] },
        path: { type: 'string' },
        ref: { type: 'string' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'git_diff',
    description: '查看指定目录或工作区的 Git 状态与未提交 Diff',
    inputSchema: { type: 'object', properties: { cwd: { type: 'string' }, path: { type: 'string' } } },
  },
  {
    name: 'edit_file',
    description: '精准替换文件中的片段（支持单次替换或 edits 数组原子多处替换，自动兼容 CRLF/LF）',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        oldText: { type: 'string' },
        newText: { type: 'string' },
        replaceAll: { type: 'boolean' },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              oldText: { type: 'string' },
              newText: { type: 'string' },
              replaceAll: { type: 'boolean' },
            },
            required: ['oldText', 'newText'],
          },
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: '新建或覆盖写入本地文件',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
  {
    name: 'write_files',
    description: '一次请求批量原子写入多个文件（任一失败自动回滚已写文件）',
    inputSchema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              content: { type: 'string' },
            },
            required: ['path', 'content'],
          },
        },
      },
      required: ['files'],
    },
  },
  {
    name: 'delete_file',
    description: '删除工作区内的指定文件',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'create_directory',
    description: '在工作区内创建新文件夹（支持递归）',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'move_path',
    description: '移动或重命名工作区内的文件或文件夹',
    inputSchema: {
      type: 'object',
      properties: { from: { type: 'string' }, to: { type: 'string' } },
      required: ['from', 'to'],
    },
  },
  {
    name: 'run_command',
    description: '在工作区或子目录中执行本机终端命令（支持流式输出与随时终止，最长 600s）',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string' },
        timeoutMs: { type: 'number' },
        processId: { type: 'string' },
      },
      required: ['command'],
    },
  },
];

async function readSingleFile(relPath, startLineArg = 1, endLineArg = 300) {
  const abs = await resolveSafePath(relPath);
  assertNotSensitive(abs);
  const stat = await fs.stat(abs);
  if (stat.isDirectory()) throw new Error(\`路径是目录而非文件: \${relPath}\`);
  if (stat.size > MAX_READ_BYTES) {
    throw new Error(\`文件体积超过 2MB 限制 (\${(stat.size / 1024 / 1024).toFixed(2)}MB)\`);
  }
  const raw = await fs.readFile(abs, 'utf8');
  const lines = raw.split(/\\r?\\n/);
  const totalLines = lines.length;
  const start = Math.max(1, Number(startLineArg || 1));
  const end = Math.min(totalLines, Number(endLineArg || Math.min(totalLines, start + 299)));
  return {
    path: toPosix(path.relative(ROOT_REAL, abs)),
    startLine: start,
    endLine: end,
    totalLines,
    truncated: end < totalLines,
    content: lines.slice(start - 1, end).join('\\n'),
  };
}

async function executeCommand(args = {}, hooks = {}) {
  assertWritable('run_command');
  if (ACTIVE_NO_SHELL) throw new Error('LocalBridge 已启用 --no-shell 模式，禁止执行终端命令');
  const command = String(args.command || '').trim();
  if (!command) throw new Error('command 不能为空');
  const cwdAbs = await resolveSafePath(args.cwd || '.');
  const timeoutMs = Math.min(600000, Math.max(2000, Number(args.timeoutMs || 90000)));
  const processId = String(args.processId || crypto.randomUUID());

  return await new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command, {
      cwd: cwdAbs,
      shell: true,
      env: { ...process.env, CI: process.env.CI || 'true' },
    });
    activeProcesses.set(processId, child);
    hooks.onStart?.(processId);

    let stdout = '';
    let stderr = '';
    let killedByTimeout = false;

    const timer = setTimeout(() => {
      killedByTimeout = true;
      terminateChildTree(child);
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      if (stdout.length < 160000) stdout += text;
      hooks.onStdout?.(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      if (stderr.length < 160000) stderr += text;
      hooks.onStderr?.(text);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      activeProcesses.delete(processId);
      resolve({
        processId,
        exitCode: -1,
        stdout,
        stderr: err.message,
        durationMs: Date.now() - startedAt,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      activeProcesses.delete(processId);
      resolve({
        processId,
        exitCode: typeof code === 'number' ? code : -1,
        stdout,
        stderr: killedByTimeout
          ? \`\${stderr}\\n[LocalBridge] 命令执行超时 (\${timeoutMs}ms) 已自动终止\`
          : stderr,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

async function handleTool(tool, args = {}) {
  switch (tool) {
    case 'inspect_workspace': {
      const targetRel = String(args.path || '.');
      const targetAbs = await resolveSafePath(targetRel);
      const maxDepth = Math.min(4, Math.max(1, Number(args.maxDepth || 2)));
      const relPrefix = targetAbs === ROOT_REAL ? '' : toPosix(path.relative(ROOT_REAL, targetAbs));

      const stack = [];
      let scripts = undefined;
      const pkgPath = path.join(targetAbs, 'package.json');
      if (fsSync.existsSync(pkgPath)) {
        stack.push('Node.js');
        try {
          const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
          scripts = pkg.scripts;
          const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
          if (allDeps.react) stack.push('React');
          if (allDeps.next) stack.push('Next.js');
          if (allDeps.vue) stack.push('Vue');
          if (allDeps.typescript) stack.push('TypeScript');
          if (allDeps.vite) stack.push('Vite');
          if (allDeps.tailwindcss) stack.push('Tailwind CSS');
        } catch {}
      }
      if (fsSync.existsSync(path.join(targetAbs, 'binding.gyp')) || fsSync.existsSync(path.join(targetAbs, 'CMakeLists.txt'))) {
        stack.push('C++');
      }
      if (fsSync.existsSync(path.join(targetAbs, 'pyproject.toml')) || fsSync.existsSync(path.join(targetAbs, 'requirements.txt'))) {
        stack.push('Python');
      }
      if (fsSync.existsSync(path.join(targetAbs, 'Cargo.toml'))) stack.push('Rust');
      if (fsSync.existsSync(path.join(targetAbs, 'go.mod'))) stack.push('Go');

      const gitRepos = await discoverGitRepos();
      const rootGit = gitRepos.find((r) => r.path === '.') || gitRepos[0];
      const budget = { count: 0, max: 350 };
      const tree = await buildTree(targetAbs, relPrefix, 0, maxDepth, budget);

      return {
        version: VERSION,
        name: path.basename(ROOT_REAL),
        rootPath: ROOT_REAL,
        path: relPrefix || '.',
        noShell: ACTIVE_NO_SHELL,
        readOnly: ACTIVE_READ_ONLY,
        allowSecrets: ACTIVE_ALLOW_SECRETS,
        branch: rootGit?.branch,
        dirtyCount: rootGit?.dirtyCount,
        gitRepos,
        stack,
        scripts,
        truncatedTree: budget.count >= budget.max,
        tree,
      };
    }

    case 'list_directory': {
      const abs = await resolveSafePath(args.path || '.');
      const entries = await fs.readdir(abs, { withFileTypes: true });
      const result = [];
      for (const e of entries) {
        if (e.isDirectory() && IGNORED_DIRS.has(e.name)) continue;
        const full = path.join(abs, e.name);
        const rel = toPosix(path.relative(ROOT_REAL, full));
        if (e.isDirectory()) {
          result.push({ name: e.name, path: rel, type: 'dir' });
        } else {
          let size = 0;
          try { size = (await fs.stat(full)).size; } catch {}
          result.push({ name: e.name, path: rel, type: 'file', size });
        }
      }
      result.sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name)));
      return { path: toPosix(path.relative(ROOT_REAL, abs)) || '.', entries: result };
    }

    case 'find_files': {
      const baseAbs = await resolveSafePath(args.path || '.');
      const maxResults = Math.min(300, Math.max(1, Number(args.maxResults || 120)));
      const pattern = typeof args.pattern === 'string' ? args.pattern.trim() : '';
      const patternRe = pattern ? globToRegex(pattern.includes('/') ? pattern : '**/' + pattern) : null;
      const patternBaseRe = pattern && !pattern.includes('/') ? globToRegex(pattern) : null;
      const extSet = Array.isArray(args.extensions) && args.extensions.length > 0
        ? new Set(args.extensions.map((e) => String(e).toLowerCase().replace(/^\\.?/, '.')))
        : null;

      const files = [];
      let truncated = false;
      async function walk(dir) {
        if (files.length >= maxResults) { truncated = true; return; }
        let entries;
        try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const e of entries) {
          if (files.length >= maxResults) { truncated = true; return; }
          if (e.isDirectory()) {
            if (IGNORED_DIRS.has(e.name)) continue;
            await walk(path.join(dir, e.name));
          } else {
            const full = path.join(dir, e.name);
            const rel = toPosix(path.relative(ROOT_REAL, full));
            if (isSensitiveRelPath(rel)) continue;
            if (extSet && !extSet.has(path.extname(e.name).toLowerCase())) continue;
            if (patternRe && !patternRe.test(rel) && !(patternBaseRe && patternBaseRe.test(e.name))) continue;
            files.push(rel);
          }
        }
      }
      await walk(baseAbs);
      return { basePath: toPosix(path.relative(ROOT_REAL, baseAbs)) || '.', count: files.length, truncated, files };
    }

    case 'read_file': {
      return await readSingleFile(args.path, args.startLine, args.endLine);
    }

    case 'read_files': {
      const specs = Array.isArray(args.files) ? args.files.slice(0, 12) : [];
      if (specs.length === 0) throw new Error('read_files 需要非空的 files 数组');
      const results = [];
      for (const spec of specs) {
        try {
          const item = await readSingleFile(spec.path, spec.startLine, spec.endLine);
          results.push({ ok: true, ...item });
        } catch (err) {
          results.push({
            ok: false,
            path: String(spec.path || ''),
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return { count: results.length, files: results };
    }

    case 'search_files': {
      const query = String(args.query || '');
      if (!query) throw new Error('search_files 需要提供非空的 query');
      const baseAbs = await resolveSafePath(args.path || '.');
      const maxResults = Math.min(150, Math.max(1, Number(args.maxResults || 50)));
      const include = typeof args.include === 'string' ? args.include : '';
      const useRegex = Boolean(args.regex);
      const caseSensitive = Boolean(args.caseSensitive);
      const contextLines = Math.min(4, Math.max(0, Number(args.contextLines || 0)));

      const matcher = useRegex ? new RegExp(query, caseSensitive ? '' : 'i') : null;
      const needle = caseSensitive ? query : query.toLowerCase();

      const matches = [];
      async function walk(dir) {
        if (matches.length >= maxResults) return;
        let entries;
        try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (matches.length >= maxResults) return;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            if (IGNORED_DIRS.has(e.name)) continue;
            await walk(full);
          } else {
            const rel = toPosix(path.relative(ROOT_REAL, full));
            if (isSensitiveRelPath(rel)) continue;
            if (!matchesIncludeFilter(rel, include)) continue;
            try {
              const stat = await fs.stat(full);
              if (stat.size > 512 * 1024) continue;
              const content = await fs.readFile(full, 'utf8');
              if (content.includes('\\u0000')) continue;
              const lines = content.split(/\\r?\\n/);
              for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const hit = matcher
                  ? matcher.test(line)
                  : (caseSensitive ? line.includes(needle) : line.toLowerCase().includes(needle));
                if (hit) {
                  const entry = {
                    path: rel,
                    line: i + 1,
                    preview: line.trim().slice(0, 260),
                  };
                  if (contextLines > 0) {
                    const start = Math.max(0, i - contextLines);
                    const end = Math.min(lines.length - 1, i + contextLines);
                    entry.context = lines.slice(start, end + 1).map((l, idx) => \`\${start + idx + 1}: \${l}\`).join('\\n');
                  }
                  matches.push(entry);
                  if (matches.length >= maxResults) return;
                }
              }
            } catch {}
          }
        }
      }
      await walk(baseAbs);
      return { query, include: include || undefined, matchCount: matches.length, matches };
    }

    case 'git_inspect': {
      let rawCwd = typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : '';
      let targetPath = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : '';
      if (!rawCwd && targetPath) {
        try {
          const maybeRepo = await resolveSafePath(targetPath);
          if (fsSync.existsSync(path.join(maybeRepo, '.git'))) {
            rawCwd = targetPath;
            targetPath = '';
          }
        } catch {}
      }
      const cwdAbs = await resolveSafePath(rawCwd || '.');
      const action = String(args.action || 'status');
      const ref = typeof args.ref === 'string' && args.ref.trim() ? args.ref.trim() : '';
      const limit = Math.min(50, Math.max(1, Number(args.limit || 15)));

      if (ref && !/^[a-zA-Z0-9._\\/~^@{}-]+$/.test(ref)) {
        throw new Error(\`非法 Git ref: \${ref}\`);
      }

      const cwdRel = toPosix(path.relative(ROOT_REAL, cwdAbs)) || '.';
      try {
        const branch = runGitSafe(cwdAbs, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
        let outputText = '';
        if (action === 'status') {
          outputText = runGitSafe(cwdAbs, ['status', '--short', '--branch']);
        } else if (action === 'diff') {
          const gitArgs = ['diff', '--no-color'];
          if (targetPath) gitArgs.push('--', targetPath);
          outputText = runGitSafe(cwdAbs, gitArgs);
        } else if (action === 'staged_diff') {
          const gitArgs = ['diff', '--cached', '--no-color'];
          if (targetPath) gitArgs.push('--', targetPath);
          outputText = runGitSafe(cwdAbs, gitArgs);
        } else if (action === 'log') {
          const gitArgs = ['log', \`-n\${limit}\`, '--date=short', '--pretty=format:%h %ad %an | %s'];
          if (targetPath) gitArgs.push('--', targetPath);
          outputText = runGitSafe(cwdAbs, gitArgs);
        } else if (action === 'branches') {
          outputText = runGitSafe(cwdAbs, ['branch', '-vv', '--no-color']);
        } else if (action === 'show') {
          const gitArgs = ['show', '--stat', '--no-color', ref || 'HEAD'];
          if (targetPath) gitArgs.push('--', targetPath);
          outputText = runGitSafe(cwdAbs, gitArgs);
        } else {
          throw new Error(\`不支持的 git_inspect action: \${action}\`);
        }

        const truncated = outputText.length > 60000;
        return {
          cwd: cwdRel,
          branch,
          action,
          truncated,
          output: outputText.slice(0, 60000),
        };
      } catch (err) {
        return {
          cwd: cwdRel,
          action,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    case 'git_diff': {
      let rawCwd = typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : '';
      let targetPath = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : '';
      if (!rawCwd && targetPath) {
        try {
          const maybeRepo = await resolveSafePath(targetPath);
          if (fsSync.existsSync(path.join(maybeRepo, '.git'))) {
            rawCwd = targetPath;
            targetPath = '';
          }
        } catch {}
      }
      const cwdAbs = await resolveSafePath(rawCwd || '.');
      const cwdRel = toPosix(path.relative(ROOT_REAL, cwdAbs)) || '.';
      try {
        const status = runGitSafe(cwdAbs, ['status', '--short', '--branch']).trim();
        const diffArgs = ['diff', '--no-color'];
        if (targetPath) diffArgs.push('--', targetPath);
        const diff = runGitSafe(cwdAbs, diffArgs);
        return { cwd: cwdRel, status, diff: diff.slice(0, 80000) };
      } catch (err) {
        return { cwd: cwdRel, status: '', diff: '', error: err instanceof Error ? err.message : String(err) };
      }
    }

    case 'edit_file': {
      assertWritable('edit_file');
      const abs = await resolveSafePath(args.path);
      assertNotSensitive(abs);
      const original = await fs.readFile(abs, 'utf8');
      const editList = Array.isArray(args.edits) && args.edits.length > 0
        ? args.edits
        : [{ oldText: args.oldText, newText: args.newText, replaceAll: args.replaceAll }];

      const fileUsesCrlf = original.includes('\\r\\n');
      let updated = original;
      let appliedCount = 0;
      for (let i = 0; i < editList.length; i++) {
        const item = editList[i];
        let oldText = String(item.oldText ?? '');
        let newText = String(item.newText ?? '');
        const replaceAll = Boolean(item.replaceAll);
        if (!oldText) throw new Error(\`第 \${i + 1} 项编辑缺少 oldText\`);
        let firstIdx = updated.indexOf(oldText);
        if (firstIdx === -1) {
          if (fileUsesCrlf && !oldText.includes('\\r\\n') && oldText.includes('\\n')) {
            const crlfOld = oldText.replace(/\\n/g, '\\r\\n');
            const crlfIdx = updated.indexOf(crlfOld);
            if (crlfIdx !== -1) {
              oldText = crlfOld;
              newText = newText.replace(/\\r?\\n/g, '\\r\\n');
              firstIdx = crlfIdx;
            }
          } else if (!fileUsesCrlf && oldText.includes('\\r\\n')) {
            const lfOld = oldText.replace(/\\r\\n/g, '\\n');
            const lfIdx = updated.indexOf(lfOld);
            if (lfIdx !== -1) {
              oldText = lfOld;
              newText = newText.replace(/\\r\\n/g, '\\n');
              firstIdx = lfIdx;
            }
          }
        }
        if (firstIdx === -1) {
          throw new Error(\`第 \${i + 1} 项未找到匹配的 oldText 片段，请先 read_file 确认最新内容。\`);
        }
        if (!replaceAll && updated.indexOf(oldText, firstIdx + oldText.length) !== -1) {
          throw new Error(\`第 \${i + 1} 项 oldText 在文件中出现多次，请补充上下文或指定 replaceAll: true。\`);
        }
        updated = replaceAll ? updated.split(oldText).join(newText) : updated.replace(oldText, newText);
        appliedCount++;
      }

      await fs.writeFile(abs, updated, 'utf8');
      const canSnap = Buffer.byteLength(original, 'utf8') <= MAX_READ_BYTES;
      return {
        path: toPosix(path.relative(ROOT_REAL, abs)),
        appliedEdits: appliedCount,
        bytesWritten: Buffer.byteLength(updated, 'utf8'),
        lineCount: updated.split(/\\r?\\n/).length,
        existed: true,
        previousContent: canSnap ? original : undefined,
      };
    }

    case 'write_file': {
      assertWritable('write_file');
      const abs = await resolveSafePath(args.path, { allowNonExistent: true });
      assertNotSensitive(abs);
      let existed = false;
      let previousContent = undefined;
      try {
        const st = await fs.stat(abs);
        if (st.isFile()) {
          existed = true;
          if (st.size <= MAX_READ_BYTES) {
            previousContent = await fs.readFile(abs, 'utf8');
          }
        }
      } catch {}
      const content = String(args.content ?? '');
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, 'utf8');
      return {
        path: toPosix(path.relative(ROOT_REAL, abs)),
        bytesWritten: Buffer.byteLength(content, 'utf8'),
        lineCount: content.split(/\\r?\\n/).length,
        existed,
        previousContent,
      };
    }

    case 'write_files': {
      assertWritable('write_files');
      const items = Array.isArray(args.files) ? args.files : [];
      if (items.length === 0) throw new Error('write_files 需要非空的 files 数组');
      if (items.length > 20) throw new Error('write_files 单次最多写入 20 个文件');

      const prepared = [];
      for (const item of items) {
        const abs = await resolveSafePath(item.path, { allowNonExistent: true });
        assertNotSensitive(abs);
        let existed = false;
        let previousBuffer = null;
        let previousText = undefined;
        try {
          const st = await fs.stat(abs);
          if (st.isDirectory()) throw new Error(\`目标是目录而非文件: \${item.path}\`);
          existed = true;
          previousBuffer = await fs.readFile(abs);
          if (st.size <= MAX_READ_BYTES) {
            previousText = previousBuffer.toString('utf8');
          }
        } catch (err) {
          if (err && err.code !== 'ENOENT') throw err;
        }
        prepared.push({
          abs,
          rel: toPosix(path.relative(ROOT_REAL, abs)),
          content: String(item.content ?? ''),
          existed,
          previousBuffer,
          previousText,
        });
      }

      const applied = [];
      try {
        for (const p of prepared) {
          await fs.mkdir(path.dirname(p.abs), { recursive: true });
          await fs.writeFile(p.abs, p.content, 'utf8');
          applied.push(p);
        }
      } catch (err) {
        for (const p of applied.reverse()) {
          try {
            if (p.existed && p.previousBuffer) {
              await fs.writeFile(p.abs, p.previousBuffer);
            } else if (!p.existed) {
              await fs.unlink(p.abs);
            }
          } catch {}
        }
        throw err;
      }

      return {
        count: prepared.length,
        files: prepared.map((p) => ({
          path: p.rel,
          bytesWritten: Buffer.byteLength(p.content, 'utf8'),
          lineCount: p.content.split(/\\r?\\n/).length,
        })),
        previousFiles: prepared.map((p) => ({
          filePath: p.rel,
          existed: p.existed,
          content: p.previousText,
        })),
      };
    }

    case 'delete_file': {
      assertWritable('delete_file');
      const abs = await resolveSafePath(args.path);
      assertNotSensitive(abs);
      const stat = await fs.stat(abs);
      if (stat.isDirectory()) throw new Error('安全策略：禁止通过 delete_file 删除目录');
      const previousContent = stat.size <= MAX_READ_BYTES ? await fs.readFile(abs, 'utf8') : undefined;
      await fs.unlink(abs);
      return {
        path: toPosix(path.relative(ROOT_REAL, abs)),
        deleted: true,
        existed: true,
        previousContent,
      };
    }

    case 'create_directory': {
      assertWritable('create_directory');
      const abs = await resolveSafePath(args.path, { allowNonExistent: true });
      await fs.mkdir(abs, { recursive: true });
      return { path: toPosix(path.relative(ROOT_REAL, abs)), created: true };
    }

    case 'move_path': {
      assertWritable('move_path');
      const fromAbs = await resolveSafePath(args.from);
      const toAbs = await resolveSafePath(args.to, { allowNonExistent: true });
      assertNotSensitive(fromAbs);
      assertNotSensitive(toAbs);
      if (fromAbs === ROOT_REAL || toAbs === ROOT_REAL) {
        throw new Error('禁止移动工作区根目录本身');
      }
      await fs.mkdir(path.dirname(toAbs), { recursive: true });
      await fs.rename(fromAbs, toAbs);
      return {
        from: toPosix(path.relative(ROOT_REAL, fromAbs)),
        to: toPosix(path.relative(ROOT_REAL, toAbs)),
        moved: true,
      };
    }

    case 'run_command': {
      return await executeCommand(args);
    }

    default:
      throw new Error(\`未知工具: \${tool}\`);
  }
}

function setCorsHeaders(req, res) {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Bridge-Token, Authorization, Mcp-Session-Id, ngrok-skip-browser-warning');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 10 * 1024 * 1024) {
        reject(new Error('请求体超过 10MB 限制'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(new Error('JSON 格式错误')); }
    });
    req.on('error', reject);
  });
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function isAuthorized(req, urlObj) {
  const headerToken = req.headers['x-bridge-token'];
  const authHeader = String(req.headers['authorization'] || '');
  const bearer = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
  const pathToken = urlObj.pathname.startsWith('/mcp/') ? decodeURIComponent(urlObj.pathname.slice(5)) : '';
  return safeEqual(headerToken, ACTIVE_TOKEN) || safeEqual(bearer, ACTIVE_TOKEN) || safeEqual(pathToken, ACTIVE_TOKEN);
}

async function handleMcpJsonRpc(body) {
  const { id = null, method, params = {} } = body || {};
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2025-03-26',
        serverInfo: { name: 'local-bridge', version: VERSION },
        capabilities: { tools: {} },
      },
    };
  }
  if (method === 'notifications/initialized' || method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOL_SCHEMAS } };
  }
  if (method === 'tools/call') {
    try {
      const data = await handleTool(params.name, params.arguments || {});
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
          isError: false,
        },
      };
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        },
      };
    }
  }
  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: \`Method not found: \${method}\` },
  };
}

function createServer() {
  return http.createServer(async (req, res) => {
    setCorsHeaders(req, res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const urlObj = new URL(req.url || '/', \`http://127.0.0.1:\${ACTIVE_PORT}\`);
    const pathname = urlObj.pathname;

    if (req.method === 'GET' && pathname === '/health') {
      if (!isAuthorized(req, urlObj)) {
        sendJson(res, 401, { ok: false, error: '无效的 X-Bridge-Token，请检查配对串或终端中的 Token。' });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        version: VERSION,
        name: path.basename(ROOT_REAL),
        rootPath: ROOT_REAL,
        noShell: ACTIVE_NO_SHELL,
        readOnly: ACTIVE_READ_ONLY,
        allowSecrets: ACTIVE_ALLOW_SECRETS,
      });
      return;
    }

    if (!isAuthorized(req, urlObj)) {
      sendJson(res, 401, { ok: false, error: '未授权的请求（Token 校验失败）' });
      return;
    }

    if (req.method === 'POST' && (pathname === '/mcp' || pathname.startsWith('/mcp/'))) {
      try {
        const body = await readJsonBody(req);
        const rpcRes = await handleMcpJsonRpc(body);
        sendJson(res, 200, rpcRes);
      } catch (err) {
        sendJson(res, 400, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: err instanceof Error ? err.message : String(err) },
        });
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/tool-stream') {
      try {
        const body = await readJsonBody(req);
        if (body.tool !== 'run_command') {
          const result = await handleTool(body.tool, body.args || {});
          sendJson(res, 200, { ok: true, result });
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no',
        });
        const emit = (obj) => {
          if (!res.writableEnded) {
            try { res.write(JSON.stringify(obj) + '\\n'); } catch {}
          }
        };
        const result = await executeCommand(body.args || {}, {
          onStart: (processId) => emit({ type: 'start', processId }),
          onStdout: (chunk) => emit({ type: 'stdout', chunk }),
          onStderr: (chunk) => emit({ type: 'stderr', chunk }),
        });
        emit({ type: 'done', ok: true, result });
        res.end();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!res.headersSent) {
          sendJson(res, 400, { ok: false, error: msg });
        } else {
          try { res.write(JSON.stringify({ type: 'error', error: msg }) + '\\n'); } catch {}
          res.end();
        }
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/tool') {
      try {
        const body = await readJsonBody(req);
        const result = await handleTool(body.tool, body.args || {});
        sendJson(res, 200, { ok: true, result });
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/kill') {
      try {
        const body = await readJsonBody(req);
        const pid = String(body.processId || '');
        const child = activeProcesses.get(pid);
        if (child) {
          terminateChildTree(child);
          activeProcesses.delete(pid);
          sendJson(res, 200, { ok: true, killed: true });
        } else {
          sendJson(res, 200, { ok: true, killed: false });
        }
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    sendJson(res, 404, { ok: false, error: 'Not Found' });
  });
}

async function pollNgrokPublicUrl(retries = 25) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch('http://127.0.0.1:4040/api/tunnels');
      if (res.ok) {
        const data = await res.json();
        const httpsTunnel = (data.tunnels || []).find((t) => String(t.public_url || '').startsWith('https://'));
        if (httpsTunnel && httpsTunnel.public_url) return httpsTunnel.public_url;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

async function launchTunnel(kind, port) {
  if (!kind) return;
  console.log(\`[Tunnel] 正在自动启动 \${kind} 隧道 (127.0.0.1:\${port})...\`);

  if (kind === 'ngrok') {
    tunnelChild = spawn('ngrok', ['http', String(port)], {
      stdio: ['ignore', 'ignore', 'pipe'],
      shell: process.platform === 'win32',
    });
    tunnelChild.on('error', (err) => {
      console.error(\`[Tunnel] 无法启动 ngrok（请确认已安装并在 PATH 中）: \${err.message}\`);
    });
    const publicUrl = await pollNgrokPublicUrl();
    if (publicUrl) {
      printPairingBanner(publicUrl);
    } else {
      console.log('[Tunnel] 未能自动从 http://127.0.0.1:4040 读取到 ngrok 地址，请检查 ngrok 是否已配置 authtoken。');
    }
    return;
  }

  if (kind === 'cloudflared') {
    tunnelChild = spawn('cloudflared', ['tunnel', '--url', \`http://127.0.0.1:\${port}\`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    let printed = false;
    const scanChunk = (chunk) => {
      if (printed) return;
      const text = chunk.toString('utf8');
      const match = text.match(/https:\\/\\/[a-zA-Z0-9-]+\\.trycloudflare\\.com/);
      if (match) {
        printed = true;
        printPairingBanner(match[0]);
      }
    };
    tunnelChild.stdout.on('data', scanChunk);
    tunnelChild.stderr.on('data', scanChunk);
    tunnelChild.on('error', (err) => {
      console.error(\`[Tunnel] 无法启动 cloudflared（请确认已安装并在 PATH 中）: \${err.message}\`);
    });
  }
}

function printPairingBanner(publicUrl) {
  const cleanUrl = publicUrl.replace(/\\/+$/, '');
  const pairing = \`\${cleanUrl}#token=\${ACTIVE_TOKEN}\`;
  console.log('');
  console.log('============================================================');
  console.log(' 隧道已就绪！复制下方整行「一键配对串」粘贴到右侧 LocalBridge 面板：');
  console.log('');
  console.log(\`  \${pairing}\`);
  console.log('');
  console.log(\`  公网地址 : \${cleanUrl}\`);
  console.log(\`  安全密钥 : \${ACTIVE_TOKEN}\`);
  console.log('============================================================');
  console.log('');
}

function cleanupAndExit() {
  if (tunnelChild) {
    terminateChildTree(tunnelChild);
    tunnelChild = null;
  }
  for (const child of activeProcesses.values()) {
    terminateChildTree(child);
  }
  process.exit(0);
}

process.on('SIGINT', cleanupAndExit);
process.on('SIGTERM', cleanupAndExit);

async function main() {
  const cfg = CLI.mode === 'setup' ? await runSetupWizard(CLI) : CLI;
  const targetRoot = path.resolve(cfg.root || process.cwd());
  ROOT_REAL = fsSync.realpathSync(targetRoot);
  ACTIVE_PORT = cfg.port || 4829;
  ACTIVE_TOKEN = cfg.token || crypto.randomBytes(24).toString('hex');
  ACTIVE_NO_SHELL = Boolean(cfg.noShell || cfg.readOnly);
  ACTIVE_READ_ONLY = Boolean(cfg.readOnly);
  ACTIVE_ALLOW_SECRETS = Boolean(cfg.allowSecrets);

  const server = createServer();
  server.listen(ACTIVE_PORT, '127.0.0.1', async () => {
    const modeLabel = ACTIVE_READ_ONLY
      ? '硬只读（禁写禁命令）'
      : ACTIVE_NO_SHELL
        ? '仅文件读写（禁 Shell）'
        : '完整模式（读写 + Git + 流式终端）';

    console.log('');
    console.log(\`LocalBridge v\${VERSION} 已在本地启动（仅监听 127.0.0.1）\`);
    console.log('------------------------------------------------------------');
    console.log(\`工作区目录 : \${ROOT_REAL}\`);
    console.log(\`权限模式   : \${modeLabel}\`);
    console.log(\`敏感文件保护: \${ACTIVE_ALLOW_SECRETS ? '已关闭 (--allow-secrets)' : '已开启（自动拦截 .env / 私钥 / *.pem）'}\`);
    console.log(\`本机地址   : http://127.0.0.1:\${ACTIVE_PORT}\`);
    console.log(\`安全 Token : \${ACTIVE_TOKEN}\`);
    console.log('------------------------------------------------------------');

    if (cfg.tunnel) {
      await launchTunnel(cfg.tunnel, ACTIVE_PORT);
    } else {
      console.log('提示：可加 --ngrok 或 --cloudflared 参数自动拉起隧道并生成一键配对串。');
      console.log('按 Ctrl+C 随时停止服务并切断所有访问。\\n');
    }
  });
}

main().catch((err) => {
  console.error('LocalBridge 启动失败:', err);
  process.exit(1);
});
`;
}
