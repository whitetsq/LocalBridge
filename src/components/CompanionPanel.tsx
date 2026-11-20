import React, { useState } from 'react';
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  GitBranch,
  Plug,
  RefreshCw,
  Shield,
  ShieldCheck,
  Trash2,
  Unplug,
  Wrench,
  XCircle,
} from 'lucide-react';
import { ApprovalCard } from './ApprovalCard';
import { getLocalBridgeScript } from '../lib/bridgeScriptTemplate';
import { parsePairingInput } from '../lib/localClient';
import type { CompanionPublicState, SecurityPolicy } from '../types/agent';

interface CompanionPanelProps {
  state: CompanionPublicState;
  tunnelUrlInput: string;
  tokenInput: string;
  connecting: boolean;
  connectError: string | null;
  hasCachedSession: boolean;
  onChangeTunnelUrl: (url: string) => void;
  onChangeToken: (token: string) => void;
  onConnect: (override?: { tunnelUrl: string; token: string }) => Promise<void>;
  onDisconnect: () => Promise<void>;
  onUpdatePolicy: (patch: {
    policy?: SecurityPolicy;
    autoApproveFileWrites?: boolean;
  }) => Promise<void>;
  onResolveApproval: (
    approvalId: string,
    decision: { approved: boolean; note?: string; addAllowlistPrefix?: string }
  ) => Promise<void>;
  onClearEvents: () => Promise<void>;
  onPreviewFile: (path: string) => void;
  onOpenGitRepo: (repoPath: string) => void;
}

function formatEventTitle(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'inspect_workspace':
      return args.path && args.path !== '.'
        ? `inspect_workspace(${String(args.path)})`
        : 'inspect_workspace';
    case 'list_directory':
      return `list_directory(${String(args.path || '.')})`;
    case 'find_files':
      return `find_files(${String(args.pattern || args.path || '.')})`;
    case 'read_file': {
      const range =
        args.startLine || args.endLine ? `:${args.startLine ?? 1}-${args.endLine ?? ''}` : '';
      return `read_file(${String(args.path || '')}${range})`;
    }
    case 'read_files': {
      const files = Array.isArray(args.files) ? args.files.length : 0;
      return `read_files(${files} files)`;
    }
    case 'search_files':
      return `search_files("${String(args.query || '')}"${args.include ? `, ${String(args.include)}` : ''})`;
    case 'git_inspect':
      return `git_inspect(${String(args.action || 'status')} @ ${String(args.cwd || '.')})`;
    case 'git_diff':
      return `git_diff(${String(args.cwd || args.path || '.')})`;
    case 'edit_file':
      return `edit_file(${String(args.path || '')})`;
    case 'write_file':
      return `write_file(${String(args.path || '')})`;
    case 'delete_file':
      return `delete_file(${String(args.path || '')})`;
    case 'create_directory':
      return `create_directory(${String(args.path || '')})`;
    case 'move_path':
      return `move_path(${String(args.from || '')} -> ${String(args.to || '')})`;
    case 'run_command':
      return `run_command(${String(args.command || '')})`;
    default:
      return name;
  }
}

export function CompanionPanel({
  state,
  tunnelUrlInput,
  tokenInput,
  connecting,
  connectError,
  hasCachedSession,
  onChangeTunnelUrl,
  onChangeToken,
  onConnect,
  onDisconnect,
  onUpdatePolicy,
  onResolveApproval,
  onClearEvents,
  onPreviewFile,
  onOpenGitRepo,
}: CompanionPanelProps) {
  const [tunnelTool, setTunnelTool] = useState<'ngrok' | 'cloudflared'>('ngrok');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const copy = (key: string, text: string) => {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1600);
  };

  const handleDownloadScript = () => {
    const blob = new Blob([getLocalBridgeScript()], {
      type: 'application/javascript;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'local-bridge.mjs';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const oneLineLaunchCmd =
    tunnelTool === 'ngrok'
      ? 'node local-bridge.mjs --ngrok --root "."'
      : 'node local-bridge.mjs --cloudflared --root "."';

  const handleUrlInputChange = (raw: string) => {
    const parsed = parsePairingInput(raw);
    if (parsed) {
      onChangeTunnelUrl(parsed.tunnelUrl);
      onChangeToken(parsed.token);
      return;
    }
    onChangeTunnelUrl(raw);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parsePairingInput(tunnelUrlInput);
    if (parsed) {
      onChangeTunnelUrl(parsed.tunnelUrl);
      onChangeToken(parsed.token);
      await onConnect(parsed);
      return;
    }
    await onConnect();
  };

  return (
    <div className="h-full flex flex-col min-h-0 bg-slate-50 dark:bg-[#0B0F17]">
      {/* Policy & Kill-Switch Toolbar */}
      <div className="px-4 py-2.5 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0F1522] flex flex-wrap items-center justify-between gap-3 shrink-0">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
            <Shield className="w-3.5 h-3.5 shrink-0" />
            <span>审批策略</span>
          </div>

          <div
            role="group"
            aria-label="伴侣安全策略"
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
                onClick={() => onUpdatePolicy({ policy: opt.id })}
                className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  state.policy === opt.id
                    ? 'bg-white dark:bg-slate-700 text-slate-950 dark:text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {state.policy === 'allowlist' && (
            <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={state.autoApproveFileWrites}
                onChange={(e) =>
                  onUpdatePolicy({ autoApproveFileWrites: e.target.checked })
                }
                className="rounded border-slate-300 dark:border-slate-600 accent-blue-600"
              />
              <span className="whitespace-nowrap">自动放行文件修改</span>
            </label>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {state.events.length > 0 && (
            <button
              type="button"
              onClick={onClearEvents}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>清空记录</span>
            </button>
          )}
          {state.connected && (
            <button
              type="button"
              onClick={onDisconnect}
              className="inline-flex items-center gap-1.5 px-3 py-1 rounded-md border border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300 hover:bg-rose-500/20 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Unplug className="w-3.5 h-3.5" />
              <span>断开隧道</span>
            </button>
          )}
        </div>
      </div>

      {/* Main Scrollable Area */}
      <div className="flex-1 overflow-y-auto px-5 py-6">
        <div className="max-w-3xl mx-auto space-y-6">
          {!state.connected ? (
            <>
              <div className="space-y-1.5">
                <h1 className="text-xl font-semibold tracking-tight text-slate-950 dark:text-white">
                  LocalBridge 对话伴侣控制台
                </h1>
                <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
                  在这里绑定本机隧道后，直接回到<strong>左侧对话框</strong>指挥读写本地代码、查询多仓库 Git 与执行终端命令；所有写入与命令都会实时推送到此页面展示逐行 Diff 与审批，Token 不会进入聊天记录。
                </p>
              </div>

              {hasCachedSession && tunnelUrlInput && tokenInput && (
                <div className="p-3.5 rounded-xl border border-blue-200 dark:border-blue-900/60 bg-blue-50/70 dark:bg-blue-950/25 flex flex-wrap items-center justify-between gap-3">
                  <div className="text-xs text-blue-900 dark:text-blue-200 min-w-0">
                    <div className="font-medium">检测到本标签页上次绑定的隧道配置</div>
                    <div className="font-mono text-[11px] text-blue-700/80 dark:text-blue-300/80 truncate mt-0.5">
                      {tunnelUrlInput}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={connecting}
                    onClick={() => onConnect()}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${connecting ? 'animate-spin' : ''}`} />
                    <span>一键重连</span>
                  </button>
                </div>
              )}

              <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
                {/* Step 01: Single-command launch */}
                <div className="lg:col-span-6 p-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] space-y-4">
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="text-sm font-semibold text-slate-950 dark:text-white">
                      01. 本机单命令启动（含隧道）
                    </h2>
                    <button
                      type="button"
                      onClick={handleDownloadScript}
                      className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>下载 v2.0 脚本</span>
                    </button>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-slate-500 dark:text-slate-400">
                        自动拉起隧道并输出一键配对串
                      </span>
                      <div className="inline-flex items-center p-0.5 rounded-md bg-slate-100 dark:bg-slate-800">
                        <button
                          type="button"
                          onClick={() => setTunnelTool('ngrok')}
                          className={`px-2 py-0.5 rounded text-[11px] font-medium cursor-pointer ${
                            tunnelTool === 'ngrok'
                              ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-xs'
                              : 'text-slate-500 dark:text-slate-400'
                          }`}
                        >
                          ngrok
                        </button>
                        <button
                          type="button"
                          onClick={() => setTunnelTool('cloudflared')}
                          className={`px-2 py-0.5 rounded text-[11px] font-medium cursor-pointer ${
                            tunnelTool === 'cloudflared'
                              ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-xs'
                              : 'text-slate-500 dark:text-slate-400'
                          }`}
                        >
                          cloudflared
                        </button>
                      </div>
                    </div>
                    <div className="relative rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0B0F17] p-2.5 font-mono text-xs text-slate-800 dark:text-slate-200">
                      <code className="block pr-10 break-all">{oneLineLaunchCmd}</code>
                      <button
                        type="button"
                        onClick={() => copy('launch', oneLineLaunchCmd)}
                        className="absolute top-2 right-2 p-1 rounded text-slate-500 hover:text-slate-900 dark:hover:text-white cursor-pointer"
                      >
                        {copiedKey === 'launch' ? (
                          <Check className="w-3.5 h-3.5 text-emerald-500" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </div>
                  </div>

                  <div className="space-y-1.5 pt-1 border-t border-slate-100 dark:border-slate-800/80">
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      或使用交互式向导（自选目录 / 权限 / 隧道）：
                    </div>
                    <div className="relative rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0B0F17] p-2 font-mono text-xs text-slate-700 dark:text-slate-300">
                      <code className="block pr-10">node local-bridge.mjs setup</code>
                      <button
                        type="button"
                        onClick={() => copy('setup', 'node local-bridge.mjs setup')}
                        className="absolute top-1.5 right-2 p-1 rounded text-slate-500 hover:text-slate-900 dark:hover:text-white cursor-pointer"
                      >
                        {copiedKey === 'setup' ? (
                          <Check className="w-3.5 h-3.5 text-emerald-500" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </div>
                  </div>
                </div>

                {/* Step 02: Bind Form (supports 1-paste pairing string) */}
                <form
                  onSubmit={handleSubmit}
                  className="lg:col-span-6 p-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] space-y-4"
                >
                  <div>
                    <h2 className="text-sm font-semibold text-slate-950 dark:text-white">
                      02. 粘贴一键配对串或手动绑定
                    </h2>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                      直接粘贴终端输出的 <code className="font-mono">https://...#token=...</code> 会自动拆分填入；凭证仅驻留内存与当前标签页会话。
                    </p>
                  </div>

                  <div className="space-y-3">
                    <label className="block space-y-1.5">
                      <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
                        一键配对串 / 隧道地址
                      </span>
                      <input
                        type="text"
                        value={tunnelUrlInput}
                        onChange={(e) => handleUrlInputChange(e.target.value)}
                        placeholder="https://xxxx.ngrok-free.app#token=..."
                        className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0F17] text-xs font-mono text-slate-900 dark:text-slate-100 focus:outline-none focus:border-blue-500"
                      />
                    </label>

                    <label className="block space-y-1.5">
                      <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
                        安全 Token（X-Bridge-Token）
                      </span>
                      <input
                        type="password"
                        value={tokenInput}
                        onChange={(e) => onChangeToken(e.target.value)}
                        placeholder="粘贴配对串时会自动填充"
                        className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0F17] text-xs font-mono text-slate-900 dark:text-slate-100 focus:outline-none focus:border-blue-500"
                      />
                    </label>
                  </div>

                  {connectError && (
                    <div className="p-3 rounded-lg border border-rose-200 dark:border-rose-900/60 bg-rose-50 dark:bg-rose-950/30 text-xs text-rose-700 dark:text-rose-300 leading-relaxed">
                      {connectError}
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={connecting || !tunnelUrlInput.trim() || !tokenInput.trim()}
                    className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 disabled:opacity-45 transition-colors cursor-pointer"
                  >
                    {connecting ? (
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Plug className="w-3.5 h-3.5" />
                    )}
                    <span>{connecting ? '正在校验隧道握手...' : '绑定隧道并开启实时监管'}</span>
                  </button>
                </form>
              </div>
            </>
          ) : (
            <>
              {/* Connected Companion Status Header */}
              <div className="p-4 rounded-xl border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50/60 dark:bg-emerald-950/20 space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <ShieldCheck className="w-5 h-5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                    <div className="min-w-0 space-y-0.5">
                      <div className="text-sm font-semibold text-emerald-950 dark:text-emerald-200 truncate">
                        已连接本机工作区：{state.workspace?.name}
                      </div>
                      <div className="text-xs font-mono text-emerald-800/80 dark:text-emerald-300/80 flex flex-wrap items-center gap-2">
                        <span>{state.workspace?.rootPath}</span>
                        <span aria-hidden="true">·</span>
                        <span>
                          {state.workspace?.readOnly
                            ? '脚本只读'
                            : state.workspace?.noShell
                              ? '脚本禁 Shell'
                              : '完整权限'}
                        </span>
                        {state.workspace?.version && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>bridge v{state.workspace.version}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                {state.workspace?.gitRepos && state.workspace.gitRepos.length > 0 && (
                  <div className="pt-2 border-t border-emerald-200/70 dark:border-emerald-900/50 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs font-mono text-emerald-900/90 dark:text-emerald-200/90">
                    {state.workspace.gitRepos.map((repo) => (
                      <button
                        key={repo.path}
                        type="button"
                        onClick={() => onOpenGitRepo(repo.path)}
                        className="inline-flex items-center gap-1.5 hover:underline cursor-pointer"
                      >
                        <GitBranch className="w-3.5 h-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                        <span>{repo.path === '.' ? repo.name : repo.path}</span>
                        {repo.branch && (
                          <span className="text-emerald-700/75 dark:text-emerald-300/75">
                            ({repo.branch}
                            {typeof repo.dirtyCount === 'number' && repo.dirtyCount > 0
                              ? `, ${repo.dirtyCount} 改动`
                              : ''}
                            )
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Pending Approval Queue (Real-time SSE) */}
              {state.pendingApprovals.length > 0 && (
                <div className="space-y-3">
                  <div className="text-xs font-semibold text-amber-700 dark:text-amber-300">
                    待审批操作（{state.pendingApprovals.length}）
                  </div>
                  {state.pendingApprovals.map((item) => (
                    <ApprovalCard
                      key={item.id}
                      approval={{
                        id: item.id,
                        turnId: item.eventId,
                        toolName: item.toolName,
                        args: item.args,
                        reason: item.toolName === 'run_command' ? '命令执行审批' : '文件与目录审批',
                        filePath: item.filePath,
                        command: item.command,
                        previewBefore: item.previewBefore,
                        previewAfter: item.previewAfter,
                        resolve: (decision) => {
                          onResolveApproval(item.id, decision);
                        },
                      }}
                    />
                  ))}
                </div>
              )}

              {/* Live Activity Timeline */}
              <div className="space-y-2.5">
                <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                  <span className="font-medium text-slate-700 dark:text-slate-300">
                    实时操作审计流
                  </span>
                  <span className="font-mono tabular-nums">共 {state.events.length} 条记录</span>
                </div>

                {state.events.length === 0 ? (
                  <div className="p-8 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] text-center space-y-2">
                    <p className="text-sm font-medium text-slate-800 dark:text-slate-200">
                      正在监听左侧对话框的本地调用...
                    </p>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      现在可以直接在左侧对话框下达指令（读代码、查多仓库 Git、修改文件或运行测试），所有调用与 Diff 审批会实时出现在这里。
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {state.events.map((ev) => {
                      const expanded = expandedIds.has(ev.id);
                      const fileArg = typeof ev.args.path === 'string' ? ev.args.path : undefined;

                      return (
                        <div
                          key={ev.id}
                          className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] overflow-hidden"
                        >
                          <div className="flex items-center justify-between gap-2 px-3.5 py-2.5 text-xs">
                            <button
                              type="button"
                              onClick={() => toggleExpand(ev.id)}
                              className="flex items-center gap-2 min-w-0 text-left cursor-pointer"
                            >
                              {expanded ? (
                                <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                              ) : (
                                <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                              )}
                              <Wrench className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                              <code className="font-mono text-[12px] text-slate-800 dark:text-slate-200 truncate">
                                {formatEventTitle(ev.toolName, ev.args)}
                              </code>
                            </button>

                            <div className="flex items-center gap-2.5 shrink-0 font-mono text-[11px] tabular-nums">
                              {fileArg &&
                                ev.toolName !== 'delete_file' &&
                                ev.toolName !== 'list_directory' &&
                                ev.toolName !== 'find_files' && (
                                  <button
                                    type="button"
                                    onClick={() => onPreviewFile(fileArg)}
                                    className="text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
                                  >
                                    预览
                                  </button>
                                )}
                              {typeof ev.durationMs === 'number' && (
                                <span className="text-slate-400">{ev.durationMs}ms</span>
                              )}
                              {ev.status === 'running' && (
                                <span className="text-blue-600 dark:text-blue-400">执行中</span>
                              )}
                              {ev.status === 'pending_approval' && (
                                <span className="text-amber-600 dark:text-amber-400">待审批</span>
                              )}
                              {ev.status === 'success' && (
                                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                              )}
                              {(ev.status === 'error' || ev.status === 'rejected') && (
                                <XCircle className="w-3.5 h-3.5 text-rose-500" />
                              )}
                            </div>
                          </div>

                          {expanded && (
                            <div className="px-3.5 py-2.5 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0B0F17] font-mono text-[11.5px] space-y-2 max-h-72 overflow-auto">
                              <div>
                                <div className="text-slate-400 mb-1">调用参数</div>
                                <pre className="whitespace-pre-wrap text-slate-700 dark:text-slate-300">
                                  {JSON.stringify(ev.args, null, 2)}
                                </pre>
                              </div>
                              {ev.error && (
                                <div className="text-rose-600 dark:text-rose-400">{ev.error}</div>
                              )}
                              {ev.result && (
                                <div>
                                  <div className="text-slate-400 mb-1">返回结果</div>
                                  <pre className="whitespace-pre-wrap text-slate-700 dark:text-slate-300">
                                    {JSON.stringify(ev.result, null, 2).slice(0, 4000)}
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
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
