import type { BridgeConfig, FileNode, SessionDiffEntry, WorkspaceSummary } from '../types/agent';

export const DEFAULT_ALLOWLIST_PREFIXES: string[] = [
  'git status',
  'git diff',
  'git log',
  'git branch',
  'npm test',
  'npm run lint',
  'npm run build',
  'npm run typecheck',
  'npx tsc',
  'tsc',
  'pytest',
  'go test',
  'cargo check',
  'cargo test',
  'ls',
  'pwd',
  'cat',
  'node -v',
];

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'coverage',
  '.venv',
  '__pycache__',
  'target',
]);

// Unsafe shell chaining / injection operators blocked from auto-allowlist
const SHELL_CHAIN_PATTERN = /[;&|`$<>]|\$\(|\n|\r/;

export function isCommandAllowlisted(command: string, allowlist: string[]): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (SHELL_CHAIN_PATTERN.test(trimmed)) return false;

  return allowlist.some((rawPrefix) => {
    const prefix = rawPrefix.trim();
    if (!prefix) return false;
    return trimmed === prefix || trimmed.startsWith(`${prefix} `);
  });
}

export function suggestAllowlistPrefix(command: string): string {
  const parts = command.trim().split(/\s+/);
  if (parts.length >= 2 && ['git', 'npm', 'pnpm', 'yarn', 'npx', 'cargo', 'go', 'python', 'python3'].includes(parts[0])) {
    if (parts[0] === 'npm' && parts[1] === 'run' && parts[2]) {
      return `npm run ${parts[2]}`;
    }
    return `${parts[0]} ${parts[1]}`;
  }
  return parts[0] || command.trim();
}

export function normalizeBridgeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export async function pingLocalBridge(
  url: string
): Promise<{ ok: boolean; noShell: boolean; version?: string; error?: string }> {
  const base = normalizeBridgeUrl(url);
  try {
    const res = await fetch(`${base}/health`, {
      method: 'GET',
      mode: 'cors',
    });
    if (!res.ok) {
      return { ok: false, noShell: false, error: `HTTP ${res.status}` };
    }
    const data = (await res.json()) as { ok?: boolean; noShell?: boolean; version?: string };
    return {
      ok: Boolean(data.ok),
      noShell: Boolean(data.noShell),
      version: data.version,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      noShell: false,
      error: msg.includes('Failed to fetch')
        ? '无法连接到本机 Bridge。请确认脚本已在终端启动，并使用 Chrome / Edge 在独立标签页打开本应用。'
        : msg,
    };
  }
}

export async function callBridgeTool(
  config: BridgeConfig,
  name: string,
  args: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const base = normalizeBridgeUrl(config.url);
  const res = await fetch(`${base}/api/tool`, {
    method: 'POST',
    mode: 'cors',
    headers: {
      'Content-Type': 'application/json',
      'X-Bridge-Token': config.token.trim(),
    },
    body: JSON.stringify({ name, args }),
  });

  const payload = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    result?: Record<string, unknown>;
    error?: string;
  };

  if (!res.ok || !payload.ok) {
    throw new Error(payload.error || `本机 Bridge 返回错误 (${res.status})`);
  }

  return payload.result ?? {};
}

export async function killBridgeProcess(
  config: BridgeConfig,
  processId: string
): Promise<boolean> {
  const base = normalizeBridgeUrl(config.url);
  const res = await fetch(`${base}/api/kill`, {
    method: 'POST',
    mode: 'cors',
    headers: {
      'Content-Type': 'application/json',
      'X-Bridge-Token': config.token.trim(),
    },
    body: JSON.stringify({ processId }),
  });
  const payload = (await res.json().catch(() => ({}))) as { killed?: boolean };
  return Boolean(payload.killed);
}

// ---------------------------------------------------------------------------
// Chrome File System Access API Driver (Direct Local Folder without Node)
// ---------------------------------------------------------------------------

export interface BrowserDirectoryHandle {
  kind: 'directory';
  name: string;
  entries(): AsyncIterableIterator<[string, BrowserFsHandle]>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<BrowserDirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<BrowserFileHandle>;
  removeEntry(name: string): Promise<void>;
}

export interface BrowserFileHandle {
  kind: 'file';
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
}

export type BrowserFsHandle = BrowserDirectoryHandle | BrowserFileHandle;

export function supportsChromeDirectoryPicker(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

export async function pickBrowserDirectory(): Promise<BrowserDirectoryHandle> {
  const picker = (window as unknown as {
    showDirectoryPicker?: (opts?: { mode?: 'read' | 'readwrite' }) => Promise<BrowserDirectoryHandle>;
  }).showDirectoryPicker;
  if (!picker) {
    throw new Error('当前浏览器不支持直接选择本地文件夹，请使用桌面版 Chrome 或 Edge，或通过 LocalBridge 脚本连接。');
  }
  return picker({ mode: 'readwrite' });
}

function splitCleanPath(relPath: string): string[] {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!normalized || normalized === '.') return [];
  const parts = normalized.split('/').filter(Boolean);
  for (const part of parts) {
    if (part === '..' || part === '.') {
      throw new Error(`不允许使用非法相对路径片段: ${relPath}`);
    }
  }
  return parts;
}

async function resolveBrowserDir(
  root: BrowserDirectoryHandle,
  relPath: string,
  create = false
): Promise<BrowserDirectoryHandle> {
  let current = root;
  for (const seg of splitCleanPath(relPath)) {
    current = await current.getDirectoryHandle(seg, { create });
  }
  return current;
}

async function resolveBrowserFile(
  root: BrowserDirectoryHandle,
  relPath: string,
  create = false
): Promise<BrowserFileHandle> {
  const parts = splitCleanPath(relPath);
  if (parts.length === 0) throw new Error('文件路径不能为空');
  const fileName = parts.pop()!;
  let dir = root;
  for (const seg of parts) {
    dir = await dir.getDirectoryHandle(seg, { create });
  }
  return dir.getFileHandle(fileName, { create });
}

export class BrowserFsWorkspace {
  private root: BrowserDirectoryHandle;
  private diffs = new Map<string, SessionDiffEntry>();

  constructor(root: BrowserDirectoryHandle) {
    this.root = root;
  }

  getSummary(): WorkspaceSummary {
    return {
      name: this.root.name,
      rootPath: `chrome-fs://${this.root.name}`,
      mode: 'browser-fs',
      noShell: true,
    };
  }

  getSessionDiffs(): SessionDiffEntry[] {
    return Array.from(this.diffs.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async listDirectory(relPath = '.'): Promise<{ path: string; entries: FileNode[] }> {
    const dir = await resolveBrowserDir(this.root, relPath);
    const entries: FileNode[] = [];
    const baseParts = splitCleanPath(relPath);

    for await (const [name, handle] of dir.entries()) {
      if (name === '.git' || name === 'node_modules') continue;
      const fullRel = [...baseParts, name].join('/');
      if (handle.kind === 'directory') {
        entries.push({ name, path: fullRel, type: 'dir' });
      } else {
        const file = await handle.getFile();
        entries.push({ name, path: fullRel, type: 'file', size: file.size });
      }
    }

    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return { path: baseParts.join('/') || '.', entries };
  }

  private async buildTree(
    dir: BrowserDirectoryHandle,
    prefix: string[],
    depth: number,
    maxDepth: number
  ): Promise<FileNode[]> {
    if (depth > maxDepth) return [];
    const out: FileNode[] = [];
    for await (const [name, handle] of dir.entries()) {
      if (IGNORED_DIRS.has(name)) continue;
      if (out.length >= 60) break;
      const rel = [...prefix, name].join('/');
      if (handle.kind === 'directory') {
        const children =
          depth < maxDepth ? await this.buildTree(handle, [...prefix, name], depth + 1, maxDepth) : [];
        out.push({ name, path: rel, type: 'dir', children });
      } else {
        out.push({ name, path: rel, type: 'file' });
      }
    }
    out.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return out;
  }

  async inspectWorkspace(): Promise<Record<string, unknown>> {
    const tree = await this.buildTree(this.root, [], 0, 2);
    const stack: string[] = [];
    let scripts: Record<string, string> = {};

    try {
      const pkgHandle = await this.root.getFileHandle('package.json');
      const pkgText = await (await pkgHandle.getFile()).text();
      const pkg = JSON.parse(pkgText) as {
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      stack.push('Node.js');
      scripts = pkg.scripts || {};
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      if (deps.typescript) stack.push('TypeScript');
      if (deps.react) stack.push('React');
      if (deps.vite) stack.push('Vite');
      if (deps.tailwindcss) stack.push('Tailwind CSS');
    } catch {
      // No package.json
    }

    return {
      name: this.root.name,
      rootPath: `chrome-fs://${this.root.name}`,
      noShell: true,
      stack,
      scripts,
      tree,
      note: '当前为 Chrome 本地文件夹直连模式，支持真实读写文件；如需执行终端命令请切换为 LocalBridge 脚本连接。',
    };
  }

  async readFile(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const relPath = String(args.path || '');
    const handle = await resolveBrowserFile(this.root, relPath, false);
    const file = await handle.getFile();
    if (file.size > 1024 * 1024 * 2) {
      throw new Error(`文件过大 (${Math.round(file.size / 1024)}KB)`);
    }
    const text = await file.text();
    const lines = text.split(/\r?\n/);
    const totalLines = lines.length;
    const start = Math.max(1, Number(args.startLine) || 1);
    const defaultEnd = Math.min(totalLines, start + 499);
    const end = Math.min(totalLines, Number(args.endLine) || defaultEnd);
    const content = lines.slice(start - 1, end).join('\n');

    return {
      path: splitCleanPath(relPath).join('/'),
      startLine: start,
      endLine: end,
      totalLines,
      truncated: end < totalLines,
      content,
    };
  }

  async searchFiles(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const query = String(args.query || '');
    if (!query) throw new Error('缺少搜索关键字 query');
    const dirRel = String(args.dir || '.');
    const limit = Math.min(80, Math.max(1, Number(args.maxResults) || 40));
    const startDir = await resolveBrowserDir(this.root, dirRel);
    const matches: Array<{ path: string; line: number; preview: string }> = [];
    const lower = query.toLowerCase();
    let regex: RegExp | null = null;
    try {
      regex = new RegExp(query, 'i');
    } catch {
      regex = null;
    }

    const walk = async (dir: BrowserDirectoryHandle, prefix: string[]) => {
      if (matches.length >= limit) return;
      for await (const [name, handle] of dir.entries()) {
        if (matches.length >= limit) return;
        if (IGNORED_DIRS.has(name)) continue;
        if (handle.kind === 'directory') {
          await walk(handle, [...prefix, name]);
        } else {
          const file = await handle.getFile();
          if (file.size > 200 * 1024) continue;
          const text = await file.text();
          if (text.includes('\u0000')) continue;
          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            const hit = regex ? regex.test(lines[i]) : lines[i].toLowerCase().includes(lower);
            if (hit) {
              matches.push({
                path: [...prefix, name].join('/'),
                line: i + 1,
                preview: lines[i].trim().slice(0, 220),
              });
              if (matches.length >= limit) return;
            }
          }
        }
      }
    };

    await walk(startDir, splitCleanPath(dirRel));
    return { query, count: matches.length, truncated: matches.length >= limit, matches };
  }

  async editFile(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const relPath = String(args.path || '');
    const oldString = String(args.oldString || '');
    const newString = String(args.newString ?? '');
    const replaceAll = Boolean(args.replaceAll);
    if (!oldString) throw new Error('oldString 不能为空');

    const handle = await resolveBrowserFile(this.root, relPath, false);
    const before = await (await handle.getFile()).text();
    const occurrences = before.split(oldString).length - 1;
    if (occurrences === 0) {
      throw new Error(`未在 ${relPath} 中找到匹配的 oldString`);
    }
    if (occurrences > 1 && !replaceAll) {
      throw new Error(`找到 ${occurrences} 处匹配，请提供更精确上下文或设置 replaceAll=true`);
    }
    const after = replaceAll
      ? before.split(oldString).join(newString)
      : before.replace(oldString, newString);

    const writable = await handle.createWritable();
    await writable.write(after);
    await writable.close();

    const cleanPath = splitCleanPath(relPath).join('/');
    const existing = this.diffs.get(cleanPath);
    this.diffs.set(cleanPath, {
      path: cleanPath,
      before: existing ? existing.before : before,
      after,
      updatedAt: Date.now(),
    });

    return {
      path: cleanPath,
      replacements: replaceAll ? occurrences : 1,
      totalLines: after.split(/\r?\n/).length,
    };
  }

  async writeFile(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const relPath = String(args.path || '');
    const content = String(args.content ?? '');
    let before = '';
    try {
      const existingHandle = await resolveBrowserFile(this.root, relPath, false);
      before = await (await existingHandle.getFile()).text();
    } catch {
      before = '';
    }

    const handle = await resolveBrowserFile(this.root, relPath, true);
    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();

    const cleanPath = splitCleanPath(relPath).join('/');
    const existing = this.diffs.get(cleanPath);
    this.diffs.set(cleanPath, {
      path: cleanPath,
      before: existing ? existing.before : before,
      after: content,
      updatedAt: Date.now(),
    });

    return {
      path: cleanPath,
      totalLines: content.split(/\r?\n/).length,
    };
  }

  async deleteFile(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const relPath = String(args.path || '');
    const parts = splitCleanPath(relPath);
    if (parts.length === 0) throw new Error('文件路径不能为空');
    const fileName = parts.pop()!;
    const dir = await resolveBrowserDir(this.root, parts.join('/'));
    await dir.removeEntry(fileName);
    return { deleted: splitCleanPath(relPath).join('/') };
  }

  async executeTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    switch (name) {
      case 'inspect_workspace':
        return this.inspectWorkspace();
      case 'list_directory':
        return this.listDirectory(String(args.path || '.'));
      case 'read_file':
        return this.readFile(args);
      case 'search_files':
        return this.searchFiles(args);
      case 'edit_file':
        return this.editFile(args);
      case 'write_file':
        return this.writeFile(args);
      case 'delete_file':
        return this.deleteFile(args);
      case 'git_diff': {
        const list = this.getSessionDiffs();
        return {
          status:
            list.length > 0
              ? `本次会话已修改 ${list.length} 个文件: ${list.map((d) => d.path).join(', ')}`
              : '本次会话暂无文件改动',
          diff: '',
          note: 'Chrome 本地文件夹模式无法直接运行 git 命令，请在「变更 Diff」面板查看本次会话改动。',
        };
      }
      case 'run_command':
        throw new Error('Chrome 文件夹直连模式不支持执行终端命令，请启动本机 LocalBridge 脚本。');
      default:
        throw new Error(`未知工具: ${name}`);
    }
  }
}
