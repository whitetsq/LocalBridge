import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Moon,
  PanelRightClose,
  PanelRightOpen,
  Plug,
  RefreshCw,
  Search,
  Send,
  Shield,
  Square,
  Sun,
  Terminal as TerminalIcon,
  Trash2,
  Wrench,
  XCircle,
} from 'lucide-react';
import { ApprovalCard } from './components/ApprovalCard';
import { BridgeSetupView } from './components/BridgeSetupView';
import { CodeInspectorPanel } from './components/CodeInspectorPanel';
import { FileTree } from './components/FileTree';
import { MarkdownView } from './components/MarkdownView';
import { TerminalView } from './components/TerminalView';
import {
  BrowserFsWorkspace,
  callBridgeTool,
  DEFAULT_ALLOWLIST_PREFIXES,
  isCommandAllowlisted,
  killBridgeProcess,
  pickBrowserDirectory,
  pingLocalBridge,
  supportsChromeDirectoryPicker,
} from './lib/localClient';
import type {
  BridgeConfig,
  ChatTurn,
  CommandRecord,
  ConnectionMode,
  FileNode,
  GeminiContent,
  GeminiPart,
  InspectorTab,
  MainView,
  OpenFileState,
  PendingApproval,
  ReasoningLevel,
  SecurityPolicy,
  SessionDiffEntry,
  ToolExecutionTrace,
  WorkspaceSummary,
} from './types/agent';

const STORAGE_BRIDGE_KEY = 'localbridge_config_v1';
const STORAGE_ALLOWLIST_KEY = 'localbridge_allowlist_v1';
const STORAGE_THEME_KEY = 'localbridge_theme_v1';

const READ_ONLY_TOOLS = new Set([
  'inspect_workspace',
  'list_directory',
  'read_file',
  'search_files',
  'git_diff',
]);

function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function updateTreeChildren(nodes: FileNode[], targetPath: string, children: FileNode[]): FileNode[] {
  return nodes.map((node) => {
    if (node.path === targetPath) {
      return { ...node, children, loaded: true };
    }
    if (node.children && node.children.length > 0) {
      return { ...node, children: updateTreeChildren(node.children, targetPath, children) };
    }
    return node;
  });
}

function formatToolLabel(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'inspect_workspace':
      return 'inspect_workspace';
    case 'list_directory':
      return `list_directory(${String(args.path || '.')})`;
    case 'read_file': {
      const range =
        args.startLine || args.endLine
          ? `:${args.startLine ?? 1}-${args.endLine ?? ''}`
          : '';
      return `read_file(${String(args.path || '')}${range})`;
    }
    case 'search_files':
      return `search_files("${String(args.query || '')}")`;
    case 'edit_file':
      return `edit_file(${String(args.path || '')})`;
    case 'write_file':
      return `write_file(${String(args.path || '')})`;
    case 'delete_file':
      return `delete_file(${String(args.path || '')})`;
    case 'git_diff':
      return `git_diff(${args.path ? String(args.path) : 'repo'})`;
    case 'run_command':
      return `run_command(${String(args.command || '')})`;
    default:
      return name;
  }
}

export default function App() {
  // Theme state
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    const saved = localStorage.getItem(STORAGE_THEME_KEY);
    return saved ? saved === 'dark' : true;
  });

  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    localStorage.setItem(STORAGE_THEME_KEY, darkMode ? 'dark' : 'light');
  }, [darkMode]);

  // Navigation & layout state
  const [activeView, setActiveView] = useState<MainView>('workbench');
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('file');

  // Connection & workspace state
  const [bridgeConfig, setBridgeConfig] = useState<BridgeConfig>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_BRIDGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<BridgeConfig>;
        return {
          url: parsed.url || 'http://127.0.0.1:4829',
          token: parsed.token || '',
        };
      }
    } catch {
      // ignore storage errors
    }
    return { url: 'http://127.0.0.1:4829', token: '' };
  });

  const [connectionMode, setConnectionMode] = useState<ConnectionMode>('disconnected');
  const [workspace, setWorkspace] = useState<WorkspaceSummary | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const browserFsRef = useRef<BrowserFsWorkspace | null>(null);

  // Security Policy & Allowlist (switchable anytime)
  const [securityPolicy, setSecurityPolicy] = useState<SecurityPolicy>('approve');
  const [autoApproveFileWrites, setAutoApproveFileWrites] = useState(false);
  const [reasoningLevel, setReasoningLevel] = useState<ReasoningLevel>('MEDIUM');
  const [allowlist, setAllowlist] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_ALLOWLIST_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) return parsed.map(String);
      }
    } catch {
      // ignore
    }
    return DEFAULT_ALLOWLIST_PREFIXES;
  });

  // Live refs so mid-loop policy toggles take immediate effect
  const policyRef = useRef(securityPolicy);
  policyRef.current = securityPolicy;
  const autoWritesRef = useRef(autoApproveFileWrites);
  autoWritesRef.current = autoApproveFileWrites;
  const allowlistRef = useRef(allowlist);
  allowlistRef.current = allowlist;
  const bridgeConfigRef = useRef(bridgeConfig);
  bridgeConfigRef.current = bridgeConfig;
  const connectionModeRef = useRef(connectionMode);
  connectionModeRef.current = connectionMode;

  useEffect(() => {
    localStorage.setItem(STORAGE_ALLOWLIST_KEY, JSON.stringify(allowlist));
  }, [allowlist]);

  // File tree & preview state
  const [fileTree, setFileTree] = useState<FileNode[]>([]);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [treeFilter, setTreeFilter] = useState('');
  const [treeLoading, setTreeLoading] = useState(false);
  const [openFile, setOpenFile] = useState<OpenFileState | null>(null);

  // Diff & Command log state
  const [gitDiffText, setGitDiffText] = useState('');
  const [gitStatusText, setGitStatusText] = useState('');
  const [diffLoading, setDiffLoading] = useState(false);
  const [sessionDiffs, setSessionDiffs] = useState<SessionDiffEntry[]>([]);
  const [commands, setCommands] = useState<CommandRecord[]>([]);

  // Chat & Agent Loop state
  const [chatTurns, setChatTurns] = useState<ChatTurn[]>([]);
  const [geminiHistory, setGeminiHistory] = useState<GeminiContent[]>([]);
  const geminiHistoryRef = useRef<GeminiContent[]>([]);
  geminiHistoryRef.current = geminiHistory;

  const [inputText, setInputText] = useState('');
  const [agentRunning, setAgentRunning] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [expandedTraceIds, setExpandedTraceIds] = useState<Set<string>>(new Set());

  const abortLoopRef = useRef(false);
  const chatBottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatTurns, pendingApproval]);

  // Low-level workspace tool executor
  const executeRawTool = useCallback(
    async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const mode = connectionModeRef.current;
      if (mode === 'bridge') {
        return callBridgeTool(bridgeConfigRef.current, name, args);
      }
      if (mode === 'browser-fs' && browserFsRef.current) {
        const res = await browserFsRef.current.executeTool(name, args);
        setSessionDiffs(browserFsRef.current.getSessionDiffs());
        return res;
      }
      throw new Error('尚未连接本地工作区');
    },
    []
  );

  // Refresh root file tree
  const refreshFileTree = useCallback(async () => {
    if (connectionModeRef.current === 'disconnected') return;
    setTreeLoading(true);
    try {
      const res = await executeRawTool('list_directory', { path: '.' });
      const entries = Array.isArray(res.entries) ? (res.entries as FileNode[]) : [];
      setFileTree(entries);
    } catch (err) {
      console.error('Failed to load directory tree:', err);
    } finally {
      setTreeLoading(false);
    }
  }, [executeRawTool]);

  const refreshDiff = useCallback(async () => {
    if (connectionModeRef.current === 'disconnected') return;
    if (connectionModeRef.current === 'browser-fs' && browserFsRef.current) {
      setSessionDiffs(browserFsRef.current.getSessionDiffs());
      return;
    }
    setDiffLoading(true);
    try {
      const res = await executeRawTool('git_diff', {});
      setGitDiffText(String(res.diff || ''));
      setGitStatusText(String(res.status || ''));
    } catch (err) {
      setGitStatusText(err instanceof Error ? err.message : String(err));
    } finally {
      setDiffLoading(false);
    }
  }, [executeRawTool]);

  // Connect to LocalBridge HTTP Server
  const handleConnectBridge = useCallback(async () => {
    setConnecting(true);
    setConnectionError(null);
    try {
      localStorage.setItem(STORAGE_BRIDGE_KEY, JSON.stringify(bridgeConfig));
      const health = await pingLocalBridge(bridgeConfig.url);
      if (!health.ok) {
        throw new Error(health.error || '无法连接本机 Bridge');
      }
      const info = await callBridgeTool(bridgeConfig, 'inspect_workspace', {});
      browserFsRef.current = null;
      connectionModeRef.current = 'bridge';
      setConnectionMode('bridge');
      setWorkspace({
        name: String(info.name || 'local-workspace'),
        rootPath: String(info.rootPath || '.'),
        mode: 'bridge',
        noShell: Boolean(info.noShell || health.noShell),
        branch: typeof info.branch === 'string' ? info.branch : undefined,
        dirtyCount: typeof info.dirtyCount === 'number' ? info.dirtyCount : undefined,
        stack: Array.isArray(info.stack) ? info.stack.map(String) : undefined,
        scripts:
          info.scripts && typeof info.scripts === 'object'
            ? (info.scripts as Record<string, string>)
            : undefined,
      });

      const dirRes = await callBridgeTool(bridgeConfig, 'list_directory', { path: '.' });
      setFileTree(Array.isArray(dirRes.entries) ? (dirRes.entries as FileNode[]) : []);
      setExpandedPaths(new Set());
      setOpenFile(null);

      // Load initial git diff silently
      callBridgeTool(bridgeConfig, 'git_diff', {})
        .then((d) => {
          setGitDiffText(String(d.diff || ''));
          setGitStatusText(String(d.status || ''));
        })
        .catch(() => {});

      setActiveView('workbench');
    } catch (err) {
      setConnectionError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnecting(false);
    }
  }, [bridgeConfig]);

  // Connect via Chrome File System Access API
  const handleConnectBrowserFolder = useCallback(async () => {
    setConnecting(true);
    setConnectionError(null);
    try {
      const handle = await pickBrowserDirectory();
      const driver = new BrowserFsWorkspace(handle);
      browserFsRef.current = driver;
      connectionModeRef.current = 'browser-fs';
      setConnectionMode('browser-fs');
      const inspected = await driver.inspectWorkspace();
      setWorkspace({
        ...driver.getSummary(),
        stack: Array.isArray(inspected.stack) ? inspected.stack.map(String) : undefined,
        scripts:
          inspected.scripts && typeof inspected.scripts === 'object'
            ? (inspected.scripts as Record<string, string>)
            : undefined,
      });
      const dirRes = await driver.listDirectory('.');
      setFileTree(dirRes.entries);
      setExpandedPaths(new Set());
      setOpenFile(null);
      setSessionDiffs([]);
      setActiveView('workbench');
    } catch (err) {
      if ((err as { name?: string })?.name !== 'AbortError') {
        setConnectionError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setConnecting(false);
    }
  }, []);

  const handleDisconnect = useCallback(() => {
    browserFsRef.current = null;
    connectionModeRef.current = 'disconnected';
    setConnectionMode('disconnected');
    setWorkspace(null);
    setFileTree([]);
    setOpenFile(null);
    setGitDiffText('');
    setGitStatusText('');
    setSessionDiffs([]);
  }, []);

  // File tree interactions
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
        const res = await executeRawTool('list_directory', { path: dirPath });
        const entries = Array.isArray(res.entries) ? (res.entries as FileNode[]) : [];
        setFileTree((prev) => updateTreeChildren(prev, dirPath, entries));
      } catch (err) {
        console.error('Failed to expand directory:', err);
      }
    },
    [expandedPaths, executeRawTool]
  );

  const handleOpenFile = useCallback(
    async (filePath: string) => {
      setOpenFile({ path: filePath, content: '', totalLines: 0, loading: true });
      setInspectorOpen(true);
      setInspectorTab('file');
      try {
        const res = await executeRawTool('read_file', {
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
    [executeRawTool]
  );

  // Manual command runner & kill
  const handleRunManualCommand = useCallback(async (command: string, cwd: string) => {
    const id = uid('cmd');
    const processId = uid('proc');
    const startedAt = Date.now();
    setCommands((prev) => [
      {
        id,
        processId,
        command,
        cwd,
        status: 'running',
        stdout: '',
        stderr: '',
        startedAt,
        source: 'manual',
      },
      ...prev,
    ]);

    try {
      const res = await callBridgeTool(bridgeConfigRef.current, 'run_command', {
        command,
        cwd,
        timeoutMs: 60000,
        processId,
      });
      const exitCode = typeof res.exitCode === 'number' ? res.exitCode : 0;
      setCommands((prev) =>
        prev.map((c) =>
          c.id === id
            ? {
                ...c,
                status: exitCode === 0 ? 'completed' : 'failed',
                exitCode,
                stdout: String(res.stdout || ''),
                stderr: String(res.stderr || ''),
                durationMs: Number(res.durationMs || Date.now() - startedAt),
              }
            : c
        )
      );
    } catch (err) {
      setCommands((prev) =>
        prev.map((c) =>
          c.id === id
            ? {
                ...c,
                status: 'failed',
                exitCode: -1,
                stderr: err instanceof Error ? err.message : String(err),
                durationMs: Date.now() - startedAt,
              }
            : c
        )
      );
    }
  }, []);

  const handleKillCommand = useCallback(async (record: CommandRecord) => {
    if (!record.processId || connectionModeRef.current !== 'bridge') return;
    try {
      await killBridgeProcess(bridgeConfigRef.current, record.processId);
      setCommands((prev) =>
        prev.map((c) => (c.id === record.id ? { ...c, status: 'killed' } : c))
      );
    } catch (err) {
      console.error('Kill command failed:', err);
    }
  }, []);

  // Build preview before/after for edit_file / write_file approval cards
  const prepareMutationPreview = useCallback(
    async (
      toolName: string,
      args: Record<string, unknown>
    ): Promise<{ previewBefore?: string; previewAfter?: string }> => {
      const filePath = String(args.path || '');
      if (!filePath) return {};

      if (toolName === 'write_file') {
        let before = '';
        try {
          const existing = await executeRawTool('read_file', {
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
          const existing = await executeRawTool('read_file', {
            path: filePath,
            startLine: 1,
            endLine: 4000,
          });
          const before = String(existing.content ?? '');
          const oldStr = String(args.oldString ?? '');
          const newStr = String(args.newString ?? '');
          const replaceAll = Boolean(args.replaceAll);
          if (oldStr && before.includes(oldStr)) {
            const after = replaceAll
              ? before.split(oldStr).join(newStr)
              : before.replace(oldStr, newStr);
            return { previewBefore: before, previewAfter: after };
          }
          return { previewBefore: oldStr, previewAfter: newStr };
        } catch {
          return {
            previewBefore: String(args.oldString ?? ''),
            previewAfter: String(args.newString ?? ''),
          };
        }
      }

      return {};
    },
    [executeRawTool]
  );

  // Ask human approval inline
  const requestApproval = useCallback(
    (payload: Omit<PendingApproval, 'resolve'>) =>
      new Promise<{ approved: boolean; note?: string; addAllowlistPrefix?: string }>((resolve) => {
        setPendingApproval({
          ...payload,
          resolve: (decision) => {
            setPendingApproval(null);
            resolve(decision);
          },
        });
      }),
    []
  );

  const patchTrace = useCallback(
    (turnId: string, traceId: string, patch: Partial<ToolExecutionTrace>) => {
      setChatTurns((prev) =>
        prev.map((turn) => {
          if (turn.id !== turnId) return turn;
          return {
            ...turn,
            tools: (turn.tools || []).map((t) => (t.id === traceId ? { ...t, ...patch } : t)),
          };
        })
      );
    },
    []
  );

  // Execute one agent tool call with security policy enforcement
  const executeAgentToolCall = useCallback(
    async (
      turnId: string,
      trace: ToolExecutionTrace
    ): Promise<Record<string, unknown>> => {
      const { name, args } = trace;
      const policy = policyRef.current;

      // Hard block in readonly mode
      if (policy === 'readonly' && !READ_ONLY_TOOLS.has(name)) {
        patchTrace(turnId, trace.id, {
          status: 'rejected',
          error: '当前为只读模式，已拦截写入或命令执行操作。',
        });
        return {
          rejected: true,
          error: '当前安全策略为只读模式，不允许写入文件或执行终端命令。请仅提供分析与修改建议。',
        };
      }

      // Check whether approval is required
      let needsApproval = false;
      if (name === 'run_command') {
        const cmd = String(args.command || '');
        if (policy === 'approve') {
          needsApproval = true;
        } else if (policy === 'allowlist') {
          needsApproval = !isCommandAllowlisted(cmd, allowlistRef.current);
        }
      } else if (name === 'edit_file' || name === 'write_file' || name === 'delete_file') {
        needsApproval = !(policy === 'allowlist' && autoWritesRef.current && name !== 'delete_file');
      }

      if (needsApproval) {
        const preview = await prepareMutationPreview(name, args);
        patchTrace(turnId, trace.id, {
          status: 'pending_approval',
          ...preview,
        });

        const decision = await requestApproval({
          id: trace.id,
          turnId,
          toolName: name,
          args,
          reason: name === 'run_command' ? '命令执行审批' : '文件改动审批',
          filePath: args.path ? String(args.path) : undefined,
          command: args.command ? String(args.command) : undefined,
          ...preview,
        });

        if (decision.addAllowlistPrefix) {
          setAllowlist((prev) =>
            prev.includes(decision.addAllowlistPrefix!)
              ? prev
              : [decision.addAllowlistPrefix!, ...prev]
          );
        }

        if (!decision.approved) {
          const rejectMsg = decision.note
            ? `用户拒绝执行该操作，用户反馈：${decision.note}`
            : '用户拒绝执行该操作。';
          patchTrace(turnId, trace.id, { status: 'rejected', error: rejectMsg });

          if (name === 'run_command') {
            setCommands((prev) => [
              {
                id: uid('cmd'),
                command: String(args.command || ''),
                cwd: String(args.cwd || '.'),
                status: 'rejected',
                stdout: '',
                stderr: rejectMsg,
                startedAt: Date.now(),
                source: 'agent',
              },
              ...prev,
            ]);
          }
          return { rejected: true, message: rejectMsg };
        }
      }

      // Execute tool on local workspace
      const startedAt = Date.now();
      patchTrace(turnId, trace.id, { status: 'running' });

      let cmdLogId: string | undefined;
      let processId: string | undefined;
      if (name === 'run_command') {
        cmdLogId = uid('cmd');
        processId = uid('proc');
        setCommands((prev) => [
          {
            id: cmdLogId!,
            processId,
            command: String(args.command || ''),
            cwd: String(args.cwd || '.'),
            status: 'running',
            stdout: '',
            stderr: '',
            startedAt,
            source: 'agent',
          },
          ...prev,
        ]);
      }

      try {
        const toolPayload = processId ? { ...args, processId } : args;
        const result = await executeRawTool(name, toolPayload);
        const durationMs = Date.now() - startedAt;

        patchTrace(turnId, trace.id, {
          status: 'success',
          result,
          durationMs,
        });

        if (cmdLogId) {
          const exitCode = typeof result.exitCode === 'number' ? result.exitCode : 0;
          setCommands((prev) =>
            prev.map((c) =>
              c.id === cmdLogId
                ? {
                    ...c,
                    status: exitCode === 0 ? 'completed' : 'failed',
                    exitCode,
                    stdout: String(result.stdout || ''),
                    stderr: String(result.stderr || ''),
                    durationMs: Number(result.durationMs || durationMs),
                  }
                : c
            )
          );
        }

        // Refresh UI state when files change
        if (name === 'edit_file' || name === 'write_file' || name === 'delete_file') {
          refreshDiff();
          if (name === 'write_file' || name === 'delete_file') {
            refreshFileTree();
          }
          if (args.path && openFile?.path === String(args.path) && name !== 'delete_file') {
            handleOpenFile(String(args.path));
          }
        }

        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const durationMs = Date.now() - startedAt;
        patchTrace(turnId, trace.id, {
          status: 'error',
          error: message,
          durationMs,
        });
        if (cmdLogId) {
          setCommands((prev) =>
            prev.map((c) =>
              c.id === cmdLogId
                ? { ...c, status: 'failed', exitCode: -1, stderr: message, durationMs }
                : c
            )
          );
        }
        return { error: message };
      }
    },
    [
      executeRawTool,
      handleOpenFile,
      openFile?.path,
      patchTrace,
      prepareMutationPreview,
      refreshDiff,
      refreshFileTree,
      requestApproval,
    ]
  );

  // Main multi-step Gemini Agent Loop
  const sendMessage = useCallback(
    async (rawPrompt?: string) => {
      const text = (rawPrompt ?? inputText).trim();
      if (!text || agentRunning) return;

      if (!rawPrompt) setInputText('');
      abortLoopRef.current = false;
      setAgentRunning(true);

      const userTurn: ChatTurn = {
        id: uid('user'),
        role: 'user',
        text,
        timestamp: Date.now(),
      };
      setChatTurns((prev) => [...prev, userTurn]);

      let history: GeminiContent[] = [
        ...geminiHistoryRef.current,
        { role: 'user', parts: [{ text }] },
      ];
      setGeminiHistory(history);

      const MAX_STEPS = 12;
      try {
        for (let step = 0; step < MAX_STEPS; step++) {
          if (abortLoopRef.current) break;

          const res = await fetch('/api/agent/step', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: history,
              thinkingLevel: reasoningLevel,
              workspaceContext: {
                workspaceName: workspace?.name,
                mode: connectionModeRef.current,
                policy: policyRef.current,
                noShell: workspace?.noShell ?? true,
              },
            }),
          });

          const data = (await res.json()) as {
            modelContent?: GeminiContent | null;
            text?: string;
            functionCalls?: Array<{ id?: string; name: string; args?: Record<string, unknown> }>;
            error?: string;
          };

          if (!res.ok || data.error) {
            throw new Error(data.error || `AI 请求失败 (HTTP ${res.status})`);
          }

          const modelContent = data.modelContent;
          const functionCalls = Array.isArray(data.functionCalls) ? data.functionCalls : [];
          const assistantText = data.text || '';

          if (modelContent) {
            history = [...history, modelContent];
            setGeminiHistory(history);
          }

          const turnId = uid('asst');
          const traces: ToolExecutionTrace[] = functionCalls.map((fc) => ({
            id: uid('tool'),
            callId: fc.id,
            name: fc.name,
            args: fc.args || {},
            status: 'running',
          }));

          setChatTurns((prev) => [
            ...prev,
            {
              id: turnId,
              role: 'assistant',
              text: assistantText,
              timestamp: Date.now(),
              tools: traces.length > 0 ? traces : undefined,
            },
          ]);

          if (functionCalls.length === 0) {
            break;
          }

          // Run read-only tools in parallel; mutating/shell tools sequentially for clear approval UX
          const allReadOnly = traces.every((t) => READ_ONLY_TOOLS.has(t.name));
          const responseParts: GeminiPart[] = [];

          if (allReadOnly) {
            const outputs = await Promise.all(
              traces.map((t) => executeAgentToolCall(turnId, t))
            );
            traces.forEach((t, idx) => {
              responseParts.push({
                functionResponse: {
                  ...(t.callId ? { id: t.callId } : {}),
                  name: t.name,
                  response: { result: outputs[idx] },
                },
              });
            });
          } else {
            for (const t of traces) {
              if (abortLoopRef.current) {
                patchTrace(turnId, t.id, { status: 'rejected', error: '用户中止了当前任务' });
                responseParts.push({
                  functionResponse: {
                    ...(t.callId ? { id: t.callId } : {}),
                    name: t.name,
                    response: { result: { rejected: true, error: '用户中止了当前任务' } },
                  },
                });
                continue;
              }
              const output = await executeAgentToolCall(turnId, t);
              responseParts.push({
                functionResponse: {
                  ...(t.callId ? { id: t.callId } : {}),
                  name: t.name,
                  response: { result: output },
                },
              });
            }
          }

          history = [...history, { role: 'user', parts: responseParts }];
          setGeminiHistory(history);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setChatTurns((prev) => [
          ...prev,
          {
            id: uid('err'),
            role: 'assistant',
            text: '',
            error: msg,
            timestamp: Date.now(),
          },
        ]);
      } finally {
        setAgentRunning(false);
      }
    },
    [agentRunning, executeAgentToolCall, inputText, patchTrace, reasoningLevel, workspace]
  );

  const handleStopAgent = () => {
    abortLoopRef.current = true;
    if (pendingApproval) {
      pendingApproval.resolve({ approved: false, note: '用户手动停止了当前任务' });
    }
  };

  const handleClearChat = () => {
    if (agentRunning) handleStopAgent();
    setChatTurns([]);
    setGeminiHistory([]);
  };

  const toggleTraceExpand = (traceId: string) => {
    setExpandedTraceIds((prev) => {
      const next = new Set(prev);
      if (next.has(traceId)) next.delete(traceId);
      else next.add(traceId);
      return next;
    });
  };

  const handleComposerKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const quickPrompts = [
    {
      label: '扫描仓库架构',
      prompt: '请先调用 inspect_workspace 检查当前本地项目的技术栈、关键目录、脚本命令和入口文件，给我一份简洁的项目结构说明。',
    },
    {
      label: '审查当前改动',
      prompt: '请调用 git_diff 查看当前仓库未提交的改动，指出潜在 Bug、边界问题或改进建议。',
    },
    {
      label: '查找 TODO 与风险点',
      prompt: '请在项目中搜索 TODO 或 FIXME 标记，读取相关上下文并按优先级整理一份处理清单。',
    },
  ];

  const isConnected = connectionMode !== 'disconnected';

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden bg-slate-50 dark:bg-[#0B0F17] text-slate-900 dark:text-slate-100">
      {/* Strict 3-Zone Top Bar Contract */}
      <header className="h-14 px-6 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0F1522] flex items-center justify-between gap-8 shrink-0">
        {/* Zone 1: Single-element Brand Wordmark */}
        <button
          type="button"
          onClick={() => setActiveView('workbench')}
          className="text-base font-bold tracking-tight text-slate-950 dark:text-white whitespace-nowrap shrink-0 cursor-pointer"
        >
          LocalBridge
        </button>

        {/* Zone 2: 4 Clean Single-Line Navigation Links */}
        <nav className="flex items-center gap-6 text-[13.5px] font-medium overflow-x-auto">
          {(
            [
              { id: 'workbench', label: '工作台' },
              { id: 'code', label: '代码与 Diff' },
              { id: 'terminal', label: '终端日志' },
              { id: 'setup', label: '本机脚本与 MCP' },
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
                {active && (
                  <span className="absolute inset-x-0 bottom-0 h-0.5 bg-blue-600 dark:bg-blue-400" />
                )}
              </button>
            );
          })}
        </nav>

        {/* Zone 3: 1 Primary Action */}
        <div className="shrink-0">
          <button
            type="button"
            onClick={() => setActiveView('setup')}
            className={`inline-flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              isConnected
                ? 'bg-emerald-600/10 text-emerald-700 dark:text-emerald-300 border border-emerald-600/30 hover:bg-emerald-600/15'
                : 'bg-blue-600 text-white hover:bg-blue-700'
            }`}
          >
            {isConnected && (
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" aria-hidden="true" />
            )}
            <span>{isConnected ? `已连接 · ${workspace?.name || '本地'}` : '连接本机仓库'}</span>
          </button>
        </div>
      </header>

      {/* Main Viewport */}
      <main className="flex-1 min-h-0 overflow-hidden">
        {activeView === 'setup' && (
          <BridgeSetupView
            config={bridgeConfig}
            connectionMode={connectionMode}
            workspace={workspace}
            connecting={connecting}
            connectionError={connectionError}
            onChangeConfig={setBridgeConfig}
            onConnectBridge={handleConnectBridge}
            onConnectBrowserFolder={handleConnectBrowserFolder}
            onDisconnect={handleDisconnect}
            onBackToWorkbench={() => setActiveView('workbench')}
          />
        )}

        {activeView === 'terminal' && (
          <TerminalView
            connectionMode={connectionMode}
            noShell={workspace?.noShell ?? true}
            commands={commands}
            allowlist={allowlist}
            onRunManualCommand={handleRunManualCommand}
            onKillCommand={handleKillCommand}
            onClearCommands={() => setCommands([])}
            onAddAllowlist={(prefix) =>
              setAllowlist((prev) => (prev.includes(prefix) ? prev : [prefix, ...prev]))
            }
            onRemoveAllowlist={(prefix) =>
              setAllowlist((prev) => prev.filter((item) => item !== prefix))
            }
            onGoSetup={() => setActiveView('setup')}
          />
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
                  disabled={!isConnected || treeLoading}
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
                {isConnected ? (
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
                      连接本地目录后即可浏览源码并查看 Git Diff。
                    </p>
                    <button
                      type="button"
                      onClick={() => setActiveView('setup')}
                      className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 cursor-pointer"
                    >
                      前往连接
                    </button>
                  </div>
                )}
              </div>
            </aside>
            <div className="lg:col-span-5 border-r border-slate-200 dark:border-slate-800 min-h-0 bg-white dark:bg-[#111827]">
              <CodeInspectorPanel
                mode="file"
                connectionMode={connectionMode}
                openFile={openFile}
                gitDiffText={gitDiffText}
                gitStatusText={gitStatusText}
                diffLoading={diffLoading}
                sessionDiffs={sessionDiffs}
                onRefreshDiff={refreshDiff}
                onAskAboutFile={(fp) => {
                  setActiveView('workbench');
                  setInputText(`请读取并分析文件 \`${fp}\` 的实现逻辑，指出潜在可优化的地方。`);
                }}
                fullHeight
              />
            </div>
            <div className="lg:col-span-4 min-h-0 bg-white dark:bg-[#111827]">
              <CodeInspectorPanel
                mode="diff"
                connectionMode={connectionMode}
                openFile={openFile}
                gitDiffText={gitDiffText}
                gitStatusText={gitStatusText}
                diffLoading={diffLoading}
                sessionDiffs={sessionDiffs}
                onRefreshDiff={refreshDiff}
                onAskAboutFile={() => {}}
                fullHeight
              />
            </div>
          </div>
        )}

        {activeView === 'workbench' && (
          <div className="h-full flex min-h-0">
            {/* Left Sidebar: Workspace Explorer & Local Settings */}
            <aside className="hidden md:flex w-[264px] shrink-0 border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0F1522] flex-col min-h-0">
              {/* Workspace Info Header */}
              <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">
                    {workspace ? workspace.name : '本地工作区'}
                  </span>
                  {isConnected && (
                    <button
                      type="button"
                      onClick={refreshFileTree}
                      disabled={treeLoading}
                      title="刷新文件列表"
                      className="p-1 rounded text-slate-400 hover:text-slate-900 dark:hover:text-white transition-colors cursor-pointer"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${treeLoading ? 'animate-spin' : ''}`} />
                    </button>
                  )}
                </div>

                {workspace ? (
                  <div className="text-[11.5px] text-slate-500 dark:text-slate-400 font-mono flex flex-wrap items-center gap-1.5">
                    <span>{workspace.mode === 'bridge' ? 'LocalBridge' : 'Chrome 目录'}</span>
                    {workspace.branch && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>{workspace.branch}</span>
                      </>
                    )}
                    {typeof workspace.dirtyCount === 'number' && workspace.dirtyCount > 0 && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="tabular-nums text-amber-600 dark:text-amber-400">
                          {workspace.dirtyCount} 改动
                        </span>
                      </>
                    )}
                  </div>
                ) : (
                  <p className="text-[11.5px] text-slate-500 dark:text-slate-400">
                    尚未连接本机目录
                  </p>
                )}
              </div>

              {/* Tree Search or Quick Connect */}
              {isConnected ? (
                <>
                  <div className="p-2.5 border-b border-slate-200 dark:border-slate-800">
                    <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0F17] focus-within:border-blue-500">
                      <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                      <input
                        type="text"
                        value={treeFilter}
                        onChange={(e) => setTreeFilter(e.target.value)}
                        placeholder="过滤文件名..."
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
                </>
              ) : (
                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                  <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                    选择一种方式挂载你电脑上的真实项目目录，AI 即可直接读取源码、提出 Diff 并运行验证命令。
                  </p>
                  <button
                    type="button"
                    onClick={() => setActiveView('setup')}
                    className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 transition-colors cursor-pointer"
                  >
                    <Plug className="w-3.5 h-3.5" />
                    <span>通过 LocalBridge 连接</span>
                  </button>
                  {supportsChromeDirectoryPicker() && (
                    <button
                      type="button"
                      onClick={handleConnectBrowserFolder}
                      disabled={connecting}
                      className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
                    >
                      <FolderOpen className="w-3.5 h-3.5" />
                      <span>Chrome 直接选择目录</span>
                    </button>
                  )}
                </div>
              )}

              {/* Sidebar Footer: Reasoning Depth & Theme Toggle */}
              <div className="p-3 border-t border-slate-200 dark:border-slate-800 space-y-2.5">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="text-slate-500 dark:text-slate-400">推理深度</span>
                  <div className="inline-flex items-center p-0.5 rounded-md bg-slate-100 dark:bg-slate-800">
                    {(
                      [
                        { id: 'LOW', label: '快' },
                        { id: 'MEDIUM', label: '均' },
                        { id: 'HIGH', label: '深' },
                      ] as Array<{ id: ReasoningLevel; label: string }>
                    ).map((lvl) => (
                      <button
                        key={lvl.id}
                        type="button"
                        onClick={() => setReasoningLevel(lvl.id)}
                        className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors cursor-pointer ${
                          reasoningLevel === lvl.id
                            ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-xs'
                            : 'text-slate-500 dark:text-slate-400'
                        }`}
                      >
                        {lvl.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex items-center justify-between text-xs">
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
              </div>
            </aside>

            {/* Center Column: Primary AI Coding Agent Workbench */}
            <section className="flex-1 flex flex-col min-w-0 min-h-0 bg-slate-50 dark:bg-[#0B0F17]">
              {/* Workspace Policy & Action Toolbar */}
              <div className="px-4 py-2.5 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0F1522] flex flex-wrap items-center justify-between gap-3 shrink-0">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                    <Shield className="w-3.5 h-3.5 shrink-0" />
                    <span className="hidden sm:inline">执行策略</span>
                  </div>

                  {/* Interactive Switchable Security Policy Control */}
                  <div
                    role="group"
                    aria-label="命令与写入安全策略"
                    className="inline-flex items-center p-0.5 rounded-lg bg-slate-100 dark:bg-slate-800/90"
                  >
                    {(
                      [
                        { id: 'approve', label: '逐条审批' },
                        { id: 'allowlist', label: '安全白名单' },
                        { id: 'readonly', label: '只读模式' },
                      ] as Array<{ id: SecurityPolicy; label: string }>
                    ).map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setSecurityPolicy(opt.id)}
                        className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                          securityPolicy === opt.id
                            ? 'bg-white dark:bg-slate-700 text-slate-950 dark:text-white shadow-xs'
                            : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>

                  {securityPolicy === 'allowlist' && (
                    <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={autoApproveFileWrites}
                        onChange={(e) => setAutoApproveFileWrites(e.target.checked)}
                        className="rounded border-slate-300 dark:border-slate-600 accent-blue-600"
                      />
                      <span className="whitespace-nowrap">自动放行文件修改</span>
                    </label>
                  )}
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {chatTurns.length > 0 && (
                    <button
                      type="button"
                      onClick={handleClearChat}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>清空对话</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setInspectorOpen((v) => !v)}
                    title={inspectorOpen ? '收起右侧检查器' : '展开右侧检查器'}
                    className="hidden xl:inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    {inspectorOpen ? (
                      <PanelRightClose className="w-3.5 h-3.5" />
                    ) : (
                      <PanelRightOpen className="w-3.5 h-3.5" />
                    )}
                    <span>{inspectorOpen ? '收起面板' : '检查器'}</span>
                  </button>
                </div>
              </div>

              {/* Conversation & Tool Execution Stream */}
              <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-6">
                <div className="max-w-3xl mx-auto space-y-5">
                  {chatTurns.length === 0 ? (
                    <div className="py-10 space-y-6">
                      <div className="space-y-2">
                        <h1 className="text-2xl font-semibold tracking-tight text-slate-950 dark:text-white">
                          {isConnected
                            ? `已就绪：开始与 ${workspace?.name} 交互`
                            : '在浏览器中直接操控你的本地代码仓库'}
                        </h1>
                        <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed max-w-2xl">
                          {isConnected
                            ? 'AI 可以按需扫描目录、检索源码、提出精确 Diff 改动并运行本机验证命令。你可以随时通过顶部切换器调整审批策略。'
                            : '通过零依赖本机 Bridge 脚本（支持文件读写 + 终端命令 + MCP 协议）或 Chrome 目录直连，无需暴露公网即可驱动本地仓库。'}
                        </p>
                      </div>

                      {!isConnected ? (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                          <div className="p-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] flex flex-col justify-between gap-4">
                            <div className="space-y-1.5">
                              <div className="text-sm font-semibold text-slate-950 dark:text-white">
                                01. 连接 LocalBridge 本机服务
                              </div>
                              <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                                下载单文件 Node.js 脚本，在仓库根目录运行后即可获得完整文件读写、Git Diff 审查、终端命令执行与标准 MCP 接口。
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={() => setActiveView('setup')}
                              className="w-fit inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 transition-colors cursor-pointer"
                            >
                              <Plug className="w-3.5 h-3.5" />
                              <span>获取脚本并连接</span>
                            </button>
                          </div>

                          <div className="p-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] flex flex-col justify-between gap-4">
                            <div className="space-y-1.5">
                              <div className="text-sm font-semibold text-slate-950 dark:text-white">
                                02. Chrome 直连本地文件夹
                              </div>
                              <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                                无需启动命令行脚本，直接用 Chrome 授权打开任意本机文件夹，立即体验 AI 读代码、全文检索与 Diff 审批写回。
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={handleConnectBrowserFolder}
                              disabled={!supportsChromeDirectoryPicker() || connecting}
                              className="w-fit inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-45 transition-colors cursor-pointer"
                            >
                              <FolderOpen className="w-3.5 h-3.5" />
                              <span>直接选择本地文件夹</span>
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                          {quickPrompts.map((item) => (
                            <button
                              key={item.label}
                              type="button"
                              onClick={() => sendMessage(item.prompt)}
                              className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] hover:border-blue-500/60 dark:hover:border-blue-500/50 text-left transition-colors space-y-1.5 cursor-pointer"
                            >
                              <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                                {item.label}
                              </div>
                              <p className="text-[11.5px] text-slate-500 dark:text-slate-400 line-clamp-2 leading-relaxed">
                                {item.prompt}
                              </p>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : (
                    chatTurns.map((turn) => (
                      <div key={turn.id} className="space-y-2.5">
                        {turn.role === 'user' ? (
                          <div className="flex justify-end">
                            <div className="max-w-[85%] px-4 py-2.5 rounded-xl bg-blue-600 text-white text-[14px] leading-relaxed whitespace-pre-wrap">
                              {turn.text}
                            </div>
                          </div>
                        ) : (
                          <div className="space-y-2.5">
                            {/* Tool Call Execution Traces */}
                            {turn.tools && turn.tools.length > 0 && (
                              <div className="space-y-1.5">
                                {turn.tools.map((trace) => {
                                  const expanded = expandedTraceIds.has(trace.id);
                                  const fileArg =
                                    trace.args.path && typeof trace.args.path === 'string'
                                      ? trace.args.path
                                      : undefined;

                                  return (
                                    <div
                                      key={trace.id}
                                      className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] overflow-hidden"
                                    >
                                      <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
                                        <button
                                          type="button"
                                          onClick={() => toggleTraceExpand(trace.id)}
                                          className="flex items-center gap-2 min-w-0 text-left cursor-pointer"
                                        >
                                          {expanded ? (
                                            <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                                          ) : (
                                            <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                                          )}
                                          <Wrench className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                                          <code className="font-mono text-[12px] text-slate-800 dark:text-slate-200 truncate">
                                            {formatToolLabel(trace.name, trace.args)}
                                          </code>
                                        </button>

                                        <div className="flex items-center gap-2.5 shrink-0 font-mono text-[11px] tabular-nums">
                                          {fileArg && trace.name !== 'delete_file' && (
                                            <button
                                              type="button"
                                              onClick={() => handleOpenFile(fileArg)}
                                              className="text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
                                            >
                                              预览文件
                                            </button>
                                          )}
                                          {typeof trace.durationMs === 'number' && (
                                            <span className="text-slate-400">
                                              {trace.durationMs}ms
                                            </span>
                                          )}
                                          {trace.status === 'running' && (
                                            <span className="text-blue-600 dark:text-blue-400">
                                              执行中
                                            </span>
                                          )}
                                          {trace.status === 'pending_approval' && (
                                            <span className="text-amber-600 dark:text-amber-400">
                                              待审批
                                            </span>
                                          )}
                                          {trace.status === 'success' && (
                                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                                          )}
                                          {(trace.status === 'error' ||
                                            trace.status === 'rejected') && (
                                            <XCircle className="w-3.5 h-3.5 text-rose-500" />
                                          )}
                                        </div>
                                      </div>

                                      {expanded && (
                                        <div className="px-3 py-2.5 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0B0F17] font-mono text-[11.5px] space-y-2 max-h-64 overflow-auto">
                                          <div>
                                            <div className="text-slate-400 mb-1">参数</div>
                                            <pre className="whitespace-pre-wrap text-slate-700 dark:text-slate-300">
                                              {JSON.stringify(trace.args, null, 2)}
                                            </pre>
                                          </div>
                                          {trace.error && (
                                            <div className="text-rose-600 dark:text-rose-400">
                                              {trace.error}
                                            </div>
                                          )}
                                          {trace.result && (
                                            <div>
                                              <div className="text-slate-400 mb-1">返回结果</div>
                                              <pre className="whitespace-pre-wrap text-slate-700 dark:text-slate-300">
                                                {JSON.stringify(trace.result, null, 2).slice(
                                                  0,
                                                  4000
                                                )}
                                              </pre>
                                            </div>
                                          )}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            )}

                            {/* Assistant Text Output */}
                            {turn.text && (
                              <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827]">
                                <MarkdownView content={turn.text} />
                              </div>
                            )}

                            {/* Error Output */}
                            {turn.error && (
                              <div className="p-3.5 rounded-xl border border-rose-200 dark:border-rose-900/60 bg-rose-50 dark:bg-rose-950/30 text-xs text-rose-700 dark:text-rose-300 leading-relaxed">
                                {turn.error}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    ))
                  )}

                  {/* Inline Human-in-the-Loop Approval Card */}
                  {pendingApproval && <ApprovalCard approval={pendingApproval} />}

                  {agentRunning && !pendingApproval && (
                    <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 px-1">
                      <RefreshCw className="w-3.5 h-3.5 animate-spin text-blue-500" />
                      <span>正在分析与调度工具...</span>
                    </div>
                  )}

                  <div ref={chatBottomRef} />
                </div>
              </div>

              {/* Bottom Composer */}
              <div className="p-4 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0F1522] shrink-0">
                <div className="max-w-3xl mx-auto">
                  <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0F17] focus-within:border-blue-500 transition-colors p-2.5">
                    <textarea
                      rows={2}
                      value={inputText}
                      onChange={(e) => setInputText(e.target.value)}
                      onKeyDown={handleComposerKeyDown}
                      placeholder={
                        isConnected
                          ? `向 ${workspace?.name} 下达指令（Enter 发送，Shift+Enter 换行）...`
                          : '可直接对话提问，或先连接本地仓库以启用文件读写与命令调用...'
                      }
                      className="w-full resize-none bg-transparent text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none px-1.5"
                    />
                    <div className="flex items-center justify-between gap-3 pt-2 border-t border-slate-200/70 dark:border-slate-800/70 mt-1.5 px-1">
                      <div className="text-[11.5px] text-slate-500 dark:text-slate-400 flex items-center gap-2 truncate">
                        <span>
                          {securityPolicy === 'approve'
                            ? '写入与命令逐条确认'
                            : securityPolicy === 'allowlist'
                              ? '白名单命令自动放行'
                              : '只读模式（禁写禁命令）'}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono">
                          {connectionMode === 'bridge'
                            ? 'LocalBridge'
                            : connectionMode === 'browser-fs'
                              ? 'Chrome 目录'
                              : '未挂载目录'}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {agentRunning ? (
                          <button
                            type="button"
                            onClick={handleStopAgent}
                            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-rose-600 text-white text-xs font-medium hover:bg-rose-700 transition-colors cursor-pointer"
                          >
                            <Square className="w-3 h-3" />
                            <span>停止</span>
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => sendMessage()}
                            disabled={!inputText.trim()}
                            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 disabled:opacity-40 transition-colors cursor-pointer"
                          >
                            <Send className="w-3.5 h-3.5" />
                            <span>发送</span>
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            {/* Right Inspector Panel (File Preview / Diff / Recent Commands) */}
            {inspectorOpen && (
              <aside className="hidden xl:flex w-[420px] shrink-0 border-l border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0F1522] flex-col min-h-0">
                <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2 shrink-0">
                  <div className="inline-flex items-center p-0.5 rounded-lg bg-slate-100 dark:bg-slate-800/90">
                    {(
                      [
                        { id: 'file', label: '文件预览' },
                        { id: 'diff', label: '变更 Diff' },
                        { id: 'commands', label: '命令记录' },
                      ] as Array<{ id: InspectorTab; label: string }>
                    ).map((tab) => (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => {
                          setInspectorTab(tab.id);
                          if (tab.id === 'diff') refreshDiff();
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
                  {inspectorTab === 'commands' ? (
                    <div className="h-full overflow-y-auto p-3.5 space-y-2.5">
                      {commands.length === 0 ? (
                        <div className="py-12 text-center space-y-2">
                          <TerminalIcon className="w-5 h-5 mx-auto text-slate-400" />
                          <p className="text-xs text-slate-500 dark:text-slate-400">
                            暂无终端命令执行记录
                          </p>
                        </div>
                      ) : (
                        commands.slice(0, 15).map((cmd) => (
                          <div
                            key={cmd.id}
                            className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0B0F17] overflow-hidden"
                          >
                            <div className="px-3 py-2 border-b border-slate-200/80 dark:border-slate-800 flex items-center justify-between gap-2 text-xs font-mono">
                              <span className="truncate text-slate-800 dark:text-slate-200">
                                {cmd.command}
                              </span>
                              <span
                                className={`shrink-0 tabular-nums ${
                                  cmd.status === 'completed'
                                    ? 'text-emerald-600 dark:text-emerald-400'
                                    : cmd.status === 'running'
                                      ? 'text-blue-600 dark:text-blue-400'
                                      : 'text-rose-600 dark:text-rose-400'
                                }`}
                              >
                                {cmd.status === 'running'
                                  ? '运行中'
                                  : `exit ${cmd.exitCode ?? 0}`}
                              </span>
                            </div>
                            {(cmd.stdout || cmd.stderr) && (
                              <pre className="p-2.5 text-[11px] font-mono text-slate-600 dark:text-slate-300 max-h-36 overflow-auto whitespace-pre-wrap">
                                {(cmd.stdout || cmd.stderr).slice(0, 1200)}
                              </pre>
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  ) : (
                    <CodeInspectorPanel
                      mode={inspectorTab}
                      connectionMode={connectionMode}
                      openFile={openFile}
                      gitDiffText={gitDiffText}
                      gitStatusText={gitStatusText}
                      diffLoading={diffLoading}
                      sessionDiffs={sessionDiffs}
                      onRefreshDiff={refreshDiff}
                      onAskAboutFile={(fp) =>
                        setInputText(`请读取并分析 \`${fp}\`，总结其核心逻辑并指出可以改进的地方。`)
                      }
                    />
                  )}
                </div>
              </aside>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
