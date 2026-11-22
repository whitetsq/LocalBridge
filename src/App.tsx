import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Moon, RefreshCw, Search, Sun, Terminal as TerminalIcon } from 'lucide-react';
import { CodeInspectorPanel } from './components/CodeInspectorPanel';
import { CompanionPanel } from './components/CompanionPanel';
import { FileTree } from './components/FileTree';
import { TerminalView } from './components/TerminalView';
import { DEFAULT_SAFE_ALLOWLIST } from './lib/localClient';
import type {
  CommandRecord,
  CompanionPublicState,
  FileNode,
  InspectorTab,
  MainView,
  OpenFileState,
  SecurityPolicy,
} from './types/agent';

const SESSION_KEY = 'localbridge.companion.session';

function updateTreeChildren(nodes: FileNode[], targetPath: string, children: FileNode[]): FileNode[] {
  return nodes.map((node) => {
    if (node.path === targetPath) {
      return { ...node, children, loaded: true };
    }
    if (node.children) {
      return { ...node, children: updateTreeChildren(node.children, targetPath, children) };
    }
    return node;
  });
}

function safeGetLocalStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetLocalStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore cross-site iframe storage restrictions
  }
}

function readCachedSession(): { tunnelUrl: string; token: string } | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { tunnelUrl?: string; token?: string };
    if (parsed.tunnelUrl && parsed.token) {
      return { tunnelUrl: parsed.tunnelUrl, token: parsed.token };
    }
  } catch {
    // ignore storage failures
  }
  return null;
}

function playGentleApprovalChime() {
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(660, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.11);
    gain.gain.setValueAtTime(0.06, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.22);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.24);
    osc.onended = () => {
      ctx.close().catch(() => {});
    };
  } catch {
    // ignore autoplay / audio context restrictions
  }
}

export function App() {
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    const saved = safeGetLocalStorage('localbridge.theme');
    if (saved === 'light') return false;
    if (saved === 'dark') return true;
    return true;
  });

  const [soundEnabled, setSoundEnabled] = useState<boolean>(() => {
    return safeGetLocalStorage('localbridge.sound') === 'on';
  });

  const [activeView, setActiveView] = useState<MainView>('companion');
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('file');

  // Companion Control Plane state synced via SSE
  const [companionState, setCompanionState] = useState<CompanionPublicState>({
    connected: false,
    tunnelUrl: '',
    workspace: null,
    health: { ok: false },
    policy: 'approve',
    autoApproveFileWrites: false,
    allowlist: DEFAULT_SAFE_ALLOWLIST,
    events: [],
    pendingApprovals: [],
  });

  const initialCached = useMemo(() => readCachedSession(), []);
  const [tunnelUrlInput, setTunnelUrlInput] = useState<string>(initialCached?.tunnelUrl || '');
  const [tokenInput, setTokenInput] = useState<string>(initialCached?.token || '');
  const [hasCachedSession, setHasCachedSession] = useState<boolean>(Boolean(initialCached));
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [pinging, setPinging] = useState(false);
  const [revertingId, setRevertingId] = useState<string | null>(null);

  // File tree, open file preview, and multi-repo Git state
  const [fileTree, setFileTree] = useState<FileNode[]>([]);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [treeFilter, setTreeFilter] = useState('');
  const [treeLoading, setTreeLoading] = useState(false);
  const [openFile, setOpenFile] = useState<OpenFileState | null>(null);

  const [selectedGitRepo, setSelectedGitRepo] = useState<string>('.');
  const [gitDiffText, setGitDiffText] = useState('');
  const [gitStatusText, setGitStatusText] = useState('');
  const [gitLogText, setGitLogText] = useState('');
  const [diffLoading, setDiffLoading] = useState(false);

  const prevConnectedRef = useRef(false);
  const prevPendingCountRef = useRef(0);
  const autoReconnectKeyRef = useRef<string | null>(null);
  const sseInitializedRef = useRef(false);
  const soundEnabledRef = useRef(soundEnabled);
  soundEnabledRef.current = soundEnabled;

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
    safeSetLocalStorage('localbridge.theme', darkMode ? 'dark' : 'light');
  }, [darkMode]);

  useEffect(() => {
    safeSetLocalStorage('localbridge.sound', soundEnabled ? 'on' : 'off');
  }, [soundEnabled]);

  // Browser tab title notification + optional chime for new pending approvals
  useEffect(() => {
    const pending = companionState.pendingApprovals.length;
    if (pending > prevPendingCountRef.current && soundEnabledRef.current) {
      playGentleApprovalChime();
    }
    prevPendingCountRef.current = pending;

    if (pending > 0) {
      document.title = `(${pending} 待审批) LocalBridge`;
    } else if (companionState.connected && companionState.workspace?.name) {
      document.title = `LocalBridge · ${companionState.workspace.name}`;
    } else {
      document.title = 'LocalBridge — 本地工作区伴侣控制台';
    }
  }, [companionState.pendingApprovals.length, companionState.connected, companionState.workspace?.name]);

  // Subscribe to Companion Control Plane SSE stream
  useEffect(() => {
    const es = new EventSource('/api/companion/events');
    es.onmessage = (event) => {
      try {
        const next = JSON.parse(event.data) as CompanionPublicState;
        sseInitializedRef.current = true;
        setCompanionState(next);
        if (next.connected) {
          autoReconnectKeyRef.current = null;
        }
        if (next.tunnelUrl) {
          setTunnelUrlInput((prev) => prev || next.tunnelUrl);
        }
      } catch {
        // ignore malformed SSE frames
      }
    };
    return () => {
      es.close();
    };
  }, []);

  // Direct UI tool proxy over the active tunnel
  const callUiTool = useCallback(
    async (tool: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
      const res = await fetch('/api/companion/ui-tool', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool, args }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        result?: Record<string, unknown>;
        error?: string;
      };
      if (!res.ok || data.ok === false) {
        throw new Error(data.error || `工具调用失败: ${tool}`);
      }
      return data.result || {};
    },
    []
  );

  const refreshFileTree = useCallback(async () => {
    setTreeLoading(true);
    try {
      const res = await callUiTool('list_directory', { path: '.' });
      const entries = Array.isArray(res.entries) ? (res.entries as FileNode[]) : [];
      setFileTree(entries);
    } catch (err) {
      console.error('Failed to load workspace tree:', err);
    } finally {
      setTreeLoading(false);
    }
  }, [callUiTool]);

  const refreshGitForRepo = useCallback(
    async (repoPath: string) => {
      setDiffLoading(true);
      try {
        const [statusRes, diffRes, logRes] = await Promise.all([
          callUiTool('git_inspect', { cwd: repoPath, action: 'status' }),
          callUiTool('git_inspect', { cwd: repoPath, action: 'diff' }),
          callUiTool('git_inspect', { cwd: repoPath, action: 'log', limit: 10 }),
        ]);
        setGitStatusText(String(statusRes.output || statusRes.error || '').trim());
        setGitDiffText(String(diffRes.output || ''));
        setGitLogText(String(logRes.output || '').trim());
      } catch {
        try {
          const fallback = await callUiTool('git_diff', { cwd: repoPath });
          setGitStatusText(String(fallback.status || ''));
          setGitDiffText(String(fallback.diff || ''));
          setGitLogText('');
        } catch {
          setGitStatusText('');
          setGitDiffText('');
          setGitLogText('');
        }
      } finally {
        setDiffLoading(false);
      }
    },
    [callUiTool]
  );

  // Sync tree & default Git repo whenever companion connects or disconnects
  useEffect(() => {
    const nowConnected = companionState.connected;
    if (nowConnected && !prevConnectedRef.current) {
      refreshFileTree();
      const repos = companionState.workspace?.gitRepos || [];
      const defaultRepo = repos.length > 0 ? repos[0].path : '.';
      setSelectedGitRepo(defaultRepo);
      refreshGitForRepo(defaultRepo);
    } else if (!nowConnected && prevConnectedRef.current) {
      setFileTree([]);
      setExpandedPaths(new Set());
      setOpenFile(null);
      setGitDiffText('');
      setGitStatusText('');
      setGitLogText('');
    }
    prevConnectedRef.current = nowConnected;
  }, [companionState.connected, companionState.workspace?.gitRepos, refreshFileTree, refreshGitForRepo]);

  // Connect / Disconnect / Health Ping / Policy / Approval / Revert / Kill handlers
  const handleConnect = useCallback(
    async (override?: { tunnelUrl: string; token: string }) => {
      const targetUrl = (override?.tunnelUrl ?? tunnelUrlInput).trim();
      const targetToken = (override?.token ?? tokenInput).trim();
      if (!targetUrl || !targetToken) return;

      setConnecting(true);
      setConnectError(null);
      try {
        const res = await fetch('/api/companion/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tunnelUrl: targetUrl, token: targetToken }),
        });
        const data = (await res.json()) as {
          ok?: boolean;
          state?: CompanionPublicState;
          error?: string;
        };
        if (!res.ok || !data.ok) {
          throw new Error(data.error || `连接失败 (HTTP ${res.status})`);
        }
        if (data.state) setCompanionState(data.state);
        try {
          sessionStorage.setItem(
            SESSION_KEY,
            JSON.stringify({ tunnelUrl: targetUrl, token: targetToken })
          );
          setHasCachedSession(true);
        } catch {
          // ignore storage errors
        }
      } catch (err) {
        setConnectError(err instanceof Error ? err.message : String(err));
      } finally {
        setConnecting(false);
      }
    },
    [tunnelUrlInput, tokenInput]
  );

  // Silent auto-reconnect when server restarts or container wakes up while tab has cached session
  useEffect(() => {
    if (!sseInitializedRef.current || companionState.connected || connecting) return;
    const cached = readCachedSession();
    if (!cached) return;
    const sessionKey = `${cached.tunnelUrl}#${cached.token}`;
    if (autoReconnectKeyRef.current === sessionKey) return;
    autoReconnectKeyRef.current = sessionKey;
    handleConnect(cached);
  }, [companionState, connecting, handleConnect]);

  const handleDisconnect = useCallback(async () => {
    autoReconnectKeyRef.current = '__manual_disconnect__';
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch {
      // ignore
    }
    setTokenInput('');
    setHasCachedSession(false);
    try {
      await fetch('/api/companion/disconnect', { method: 'POST' });
    } catch {
      // ignore
    }
  }, []);

  const handlePingHealth = useCallback(async () => {
    setPinging(true);
    try {
      await fetch('/api/companion/ping', { method: 'POST' });
    } finally {
      setPinging(false);
    }
  }, []);

  const handleUpdatePolicy = useCallback(
    async (patch: {
      policy?: SecurityPolicy;
      autoApproveFileWrites?: boolean;
      allowlist?: string[];
    }) => {
      await fetch('/api/companion/policy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
    },
    []
  );

  const handleResolveApproval = useCallback(
    async (
      approvalId: string,
      decision: { approved: boolean; note?: string; addAllowlistPrefix?: string }
    ) => {
      await fetch(`/api/companion/approvals/${encodeURIComponent(approvalId)}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(decision),
      });
    },
    []
  );

  const handleRevertEvent = useCallback(
    async (eventId: string) => {
      setRevertingId(eventId);
      try {
        const res = await fetch(`/api/companion/revert/${encodeURIComponent(eventId)}`, {
          method: 'POST',
        });
        const data = (await res.json()) as { ok?: boolean; filePath?: string; error?: string };
        if (res.ok && data.ok) {
          refreshGitForRepo(selectedGitRepo);
          if (data.filePath && openFile?.path === data.filePath) {
            // Re-read previewed file so UI reflects reverted content
            const fresh = await callUiTool('read_file', {
              path: data.filePath,
              startLine: 1,
              endLine: 500,
            }).catch(() => null);
            if (fresh) {
              setOpenFile({
                path: String(fresh.path || data.filePath),
                content: String(fresh.content ?? ''),
                totalLines: Number(fresh.totalLines || 0),
                truncated: Boolean(fresh.truncated),
                loading: false,
              });
            }
          }
        }
      } finally {
        setRevertingId(null);
      }
    },
    [callUiTool, openFile?.path, refreshGitForRepo, selectedGitRepo]
  );

  const handleKillProcess = useCallback(async (processId: string) => {
    try {
      await fetch('/api/companion/kill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ processId }),
      });
    } catch (err) {
      console.error('Failed to kill remote process:', err);
    }
  }, []);

  const handleClearEvents = useCallback(async () => {
    await fetch('/api/companion/events/clear', { method: 'POST' });
  }, []);

  // File tree & file preview
  const handleToggleDir = useCallback(
    async (dirPath: string) => {
      const next = new Set(expandedPaths);
      if (next.has(dirPath)) {
        next.delete(dirPath);
        setExpandedPaths(next);
        return;
      }
      next.add(dirPath);
      setExpandedPaths(next);
      try {
        const res = await callUiTool('list_directory', { path: dirPath });
        const entries = Array.isArray(res.entries) ? (res.entries as FileNode[]) : [];
        setFileTree((prev) => updateTreeChildren(prev, dirPath, entries));
      } catch (err) {
        console.error('Failed to expand directory:', err);
      }
    },
    [expandedPaths, callUiTool]
  );

  const handleOpenFile = useCallback(
    async (filePath: string) => {
      setOpenFile({ path: filePath, content: '', totalLines: 0, loading: true });
      setInspectorTab('file');
      try {
        const res = await callUiTool('read_file', {
          path: filePath,
          startLine: 1,
          endLine: 500,
        });
        setOpenFile({
          path: String(res.path || filePath),
          content: String(res.content ?? ''),
          totalLines: Number(res.totalLines || 0),
          truncated: Boolean(res.truncated),
          loading: false,
        });
      } catch (err) {
        setOpenFile({
          path: filePath,
          content: '',
          totalLines: 0,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [callUiTool]
  );

  // Manual command execution now streams through server.ts SSE events seamlessly
  const handleRunManualCommand = useCallback(
    async (command: string, cwd: string) => {
      try {
        await callUiTool('run_command', {
          command,
          cwd,
          timeoutMs: 90000,
        });
      } catch {
        // Error state is already pushed into the SSE event stream
      }
    },
    [callUiTool]
  );

  // Unified live-streaming command records (both companion-triggered and manual)
  const allCommands = useMemo<CommandRecord[]>(() => {
    return companionState.events
      .filter((ev) => ev.toolName === 'run_command')
      .map((ev) => {
        const res = ev.result || {};
        const exitCode = typeof res.exitCode === 'number' ? res.exitCode : undefined;
        const status: CommandRecord['status'] =
          ev.status === 'running' || ev.status === 'pending_approval'
            ? 'running'
            : ev.status === 'rejected'
              ? 'rejected'
              : ev.status === 'error' || (typeof exitCode === 'number' && exitCode !== 0)
                ? 'failed'
                : 'completed';
        const stdout =
          ev.status === 'running'
            ? String(ev.liveStdout ?? '')
            : String(res.stdout ?? ev.liveStdout ?? '');
        const stderr =
          ev.status === 'running'
            ? String(ev.liveStderr ?? '')
            : String(res.stderr ?? ev.liveStderr ?? ev.error ?? '');

        return {
          id: ev.id,
          processId: ev.processId || (typeof res.processId === 'string' ? res.processId : undefined),
          command: String(ev.args.command || ev.command || ''),
          cwd: String(ev.args.cwd || '.'),
          status,
          exitCode,
          stdout,
          stderr,
          durationMs: ev.durationMs,
          startedAt: ev.startedAt,
          source: ev.source === 'ui' ? 'manual' : 'companion',
        };
      });
  }, [companionState.events]);

  const gitRepos = companionState.workspace?.gitRepos || [];
  const healthDegraded = companionState.connected && !companionState.health.ok;

  return (
    <div className="h-screen flex flex-col bg-slate-50 dark:bg-[#0B0F17] text-slate-900 dark:text-slate-100 overflow-hidden">
      {/* Strict 3-Zone Top Navigation Bar */}
      <header className="h-14 shrink-0 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0F1522] px-4 lg:px-6 flex items-center justify-between gap-4">
        {/* Zone 1: Brand */}
        <button
          type="button"
          onClick={() => setActiveView('companion')}
          className="flex items-center gap-2.5 text-left shrink-0 cursor-pointer"
        >
          <span className="w-7 h-7 rounded-lg bg-slate-900 dark:bg-blue-600 text-white flex items-center justify-center shrink-0">
            <TerminalIcon className="w-3.5 h-3.5" />
          </span>
          <span className="text-sm font-semibold tracking-tight text-slate-950 dark:text-white whitespace-nowrap">
            LocalBridge
          </span>
        </button>

        {/* Zone 2: 3 Focused Nav Links */}
        <nav aria-label="主导航" className="flex items-center gap-6 text-[13px] font-medium">
          {(
            [
              { id: 'companion', label: '控制台' },
              { id: 'code', label: '代码与 Diff' },
              { id: 'terminal', label: '终端与脚本' },
            ] as Array<{ id: MainView; label: string }>
          ).map((item) => {
            const active = activeView === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveView(item.id)}
                className={`relative py-4 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  active
                    ? 'text-slate-950 dark:text-white'
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                {item.label}
                {item.id === 'companion' && companionState.pendingApprovals.length > 0 && (
                  <span className="ml-1.5 font-mono text-[11px] tabular-nums text-amber-600 dark:text-amber-400">
                    ({companionState.pendingApprovals.length})
                  </span>
                )}
                {active && (
                  <span className="absolute inset-x-0 bottom-0 h-0.5 bg-blue-600 dark:bg-blue-400" />
                )}
              </button>
            );
          })}
        </nav>

        {/* Zone 3: 1 Primary Status Action */}
        <div className="shrink-0">
          <button
            type="button"
            onClick={() => setActiveView('companion')}
            className={`inline-flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              healthDegraded
                ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/40 hover:bg-amber-500/20'
                : companionState.connected
                  ? 'bg-emerald-600/10 text-emerald-700 dark:text-emerald-300 border border-emerald-600/30 hover:bg-emerald-600/15'
                  : 'bg-blue-600 text-white hover:bg-blue-700'
            }`}
          >
            {companionState.connected && (
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  healthDegraded ? 'bg-amber-500' : 'bg-emerald-500'
                }`}
                aria-hidden="true"
              />
            )}
            <span>
              {healthDegraded
                ? `心跳异常 · ${companionState.workspace?.name || 'local'}`
                : companionState.connected
                  ? `已连接 · ${companionState.workspace?.name || 'local'}`
                  : '连接本机隧道'}
            </span>
          </button>
        </div>
      </header>

      {/* Main Viewport */}
      <main className="flex-1 min-h-0 overflow-hidden">
        {activeView === 'companion' && (
          <div className="h-full flex min-h-0">
            {companionState.connected && (
              <aside className="hidden md:flex w-[256px] shrink-0 border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0F1522] flex-col min-h-0">
                <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">
                    {companionState.workspace?.name || '本地仓库'}
                  </span>
                  <button
                    type="button"
                    onClick={refreshFileTree}
                    disabled={treeLoading}
                    title="刷新目录树"
                    className="p-1 rounded text-slate-400 hover:text-slate-900 dark:hover:text-white transition-colors cursor-pointer"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${treeLoading ? 'animate-spin' : ''}`} />
                  </button>
                </div>
                <div className="p-2.5 border-b border-slate-200 dark:border-slate-800">
                  <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0F17] focus-within:border-blue-500">
                    <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    <input
                      type="text"
                      value={treeFilter}
                      onChange={(e) => setTreeFilter(e.target.value)}
                      placeholder="过滤文件..."
                      className="w-full bg-transparent text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none"
                    />
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto p-1.5">
                  <FileTree
                    nodes={fileTree}
                    expandedPaths={expandedPaths}
                    selectedPath={openFile?.path}
                    filterQuery={treeFilter}
                    onToggleDir={handleToggleDir}
                    onSelectFile={handleOpenFile}
                  />
                </div>
                <div className="p-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between text-xs">
                  <span className="text-slate-500 dark:text-slate-400">界面主题</span>
                  <button
                    type="button"
                    onClick={() => setDarkMode((v) => !v)}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
                  >
                    {darkMode ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
                    <span>{darkMode ? '浅色' : '深色'}</span>
                  </button>
                </div>
              </aside>
            )}

            <div className="flex-1 min-w-0 min-h-0">
              <CompanionPanel
                state={companionState}
                tunnelUrlInput={tunnelUrlInput}
                tokenInput={tokenInput}
                connecting={connecting}
                connectError={connectError}
                hasCachedSession={hasCachedSession}
                soundEnabled={soundEnabled}
                pinging={pinging}
                revertingId={revertingId}
                onToggleSound={() => setSoundEnabled((v) => !v)}
                onPingHealth={handlePingHealth}
                onChangeTunnelUrl={setTunnelUrlInput}
                onChangeToken={setTokenInput}
                onConnect={handleConnect}
                onDisconnect={handleDisconnect}
                onUpdatePolicy={handleUpdatePolicy}
                onResolveApproval={handleResolveApproval}
                onRevertEvent={handleRevertEvent}
                onKillProcess={handleKillProcess}
                onClearEvents={handleClearEvents}
                onPreviewFile={(fp) => {
                  handleOpenFile(fp);
                  setInspectorTab('file');
                }}
                onOpenGitRepo={(repoPath) => {
                  setSelectedGitRepo(repoPath);
                  refreshGitForRepo(repoPath);
                  setInspectorTab('diff');
                }}
              />
            </div>

            {companionState.connected && (
              <aside className="hidden xl:flex w-[420px] shrink-0 border-l border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0F1522] flex-col min-h-0">
                <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2 shrink-0">
                  <div className="inline-flex items-center p-0.5 rounded-lg bg-slate-100 dark:bg-slate-800/90">
                    {(
                      [
                        { id: 'file', label: '文件预览' },
                        { id: 'diff', label: 'Git Diff' },
                      ] as Array<{ id: InspectorTab; label: string }>
                    ).map((tab) => (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => {
                          setInspectorTab(tab.id);
                          if (tab.id === 'diff') refreshGitForRepo(selectedGitRepo);
                        }}
                        className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                          inspectorTab === tab.id
                            ? 'bg-white dark:bg-slate-700 text-slate-950 dark:text-white shadow-xs'
                            : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                        }`}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex-1 min-h-0 overflow-hidden">
                  <CodeInspectorPanel
                    mode={inspectorTab}
                    connected={companionState.connected}
                    openFile={openFile}
                    gitRepos={gitRepos}
                    selectedGitRepo={selectedGitRepo}
                    onSelectGitRepo={(repoPath) => {
                      setSelectedGitRepo(repoPath);
                      refreshGitForRepo(repoPath);
                    }}
                    gitDiffText={gitDiffText}
                    gitStatusText={gitStatusText}
                    gitLogText={gitLogText}
                    diffLoading={diffLoading}
                    onRefreshDiff={() => refreshGitForRepo(selectedGitRepo)}
                  />
                </div>
              </aside>
            )}
          </div>
        )}

        {activeView === 'code' && (
          <div className="h-full grid grid-cols-1 lg:grid-cols-12 min-h-0">
            <aside className="lg:col-span-3 border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0F1522] flex flex-col min-h-0">
              <div className="px-3.5 py-2.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                  工作区目录
                </span>
                <button
                  type="button"
                  onClick={refreshFileTree}
                  disabled={!companionState.connected || treeLoading}
                  className="p-1 rounded text-slate-500 hover:text-slate-900 dark:hover:text-white disabled:opacity-40 cursor-pointer"
                  title="刷新目录树"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${treeLoading ? 'animate-spin' : ''}`} />
                </button>
              </div>
              <div className="p-2.5 border-b border-slate-200 dark:border-slate-800">
                <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0F17]">
                  <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                  <input
                    type="text"
                    value={treeFilter}
                    onChange={(e) => setTreeFilter(e.target.value)}
                    placeholder="筛选文件..."
                    className="w-full bg-transparent text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none"
                  />
                </div>
              </div>
              <div className="flex-1 overflow-y-auto p-1.5">
                {companionState.connected ? (
                  <FileTree
                    nodes={fileTree}
                    expandedPaths={expandedPaths}
                    selectedPath={openFile?.path}
                    filterQuery={treeFilter}
                    onToggleDir={handleToggleDir}
                    onSelectFile={handleOpenFile}
                  />
                ) : (
                  <div className="p-5 text-center space-y-3">
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      在控制台绑定本机隧道后即可浏览源码并切换查看多仓库 Git Diff。
                    </p>
                    <button
                      type="button"
                      onClick={() => setActiveView('companion')}
                      className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 cursor-pointer"
                    >
                      返回控制台连接
                    </button>
                  </div>
                )}
              </div>
            </aside>
            <div className="lg:col-span-5 border-r border-slate-200 dark:border-slate-800 min-h-0 bg-white dark:bg-[#111827]">
              <CodeInspectorPanel
                mode="file"
                connected={companionState.connected}
                openFile={openFile}
                gitRepos={gitRepos}
                selectedGitRepo={selectedGitRepo}
                onSelectGitRepo={(repoPath) => {
                  setSelectedGitRepo(repoPath);
                  refreshGitForRepo(repoPath);
                }}
                gitDiffText={gitDiffText}
                gitStatusText={gitStatusText}
                gitLogText={gitLogText}
                diffLoading={diffLoading}
                onRefreshDiff={() => refreshGitForRepo(selectedGitRepo)}
                fullHeight
              />
            </div>
            <div className="lg:col-span-4 min-h-0 bg-white dark:bg-[#111827]">
              <CodeInspectorPanel
                mode="diff"
                connected={companionState.connected}
                openFile={openFile}
                gitRepos={gitRepos}
                selectedGitRepo={selectedGitRepo}
                onSelectGitRepo={(repoPath) => {
                  setSelectedGitRepo(repoPath);
                  refreshGitForRepo(repoPath);
                }}
                gitDiffText={gitDiffText}
                gitStatusText={gitStatusText}
                gitLogText={gitLogText}
                diffLoading={diffLoading}
                onRefreshDiff={() => refreshGitForRepo(selectedGitRepo)}
                fullHeight
              />
            </div>
          </div>
        )}

        {activeView === 'terminal' && (
          <TerminalView
            connected={companionState.connected}
            noShell={companionState.workspace?.noShell ?? true}
            gitRepos={gitRepos}
            commands={allCommands}
            allowlist={companionState.allowlist}
            onRunManualCommand={handleRunManualCommand}
            onKillCommand={(record) =>
              record.processId ? handleKillProcess(record.processId) : Promise.resolve()
            }
            onClearCommands={handleClearEvents}
            onAddAllowlist={(prefix) => {
              const next = companionState.allowlist.includes(prefix)
                ? companionState.allowlist
                : [prefix, ...companionState.allowlist];
              handleUpdatePolicy({ allowlist: next });
            }}
            onRemoveAllowlist={(prefix) => {
              handleUpdatePolicy({
                allowlist: companionState.allowlist.filter((item) => item !== prefix),
              });
            }}
            onGoConnect={() => setActiveView('companion')}
          />
        )}
      </main>
    </div>
  );
}

export default App;
