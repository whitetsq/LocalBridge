import React, { useState } from 'react';
import { Check, Copy, Download, Play, Plus, Square, Terminal, Trash2, X } from 'lucide-react';
import { getLocalBridgeScript } from '../lib/bridgeScriptTemplate';
import type { CommandRecord, GitRepoSummary } from '../types/agent';

interface TerminalViewProps {
  connected: boolean;
  noShell: boolean;
  gitRepos: GitRepoSummary[];
  commands: CommandRecord[];
  allowlist: string[];
  onRunManualCommand: (command: string, cwd: string) => Promise<void>;
  onKillCommand: (record: CommandRecord) => Promise<void>;
  onClearCommands: () => void;
  onAddAllowlist: (prefix: string) => void;
  onRemoveAllowlist: (prefix: string) => void;
  onGoConnect: () => void;
}

export function TerminalView({
  connected,
  noShell,
  gitRepos,
  commands,
  allowlist,
  onRunManualCommand,
  onKillCommand,
  onClearCommands,
  onAddAllowlist,
  onRemoveAllowlist,
  onGoConnect,
}: TerminalViewProps) {
  const [cmdInput, setCmdInput] = useState('');
  const [cwdInput, setCwdInput] = useState('.');
  const [newPrefix, setNewPrefix] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [copiedScript, setCopiedScript] = useState(false);

  const canRunShell = connected && !noShell;

  const handleRun = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cmdInput.trim() || !canRunShell || submitting) return;
    const toRun = cmdInput.trim();
    setCmdInput('');
    setSubmitting(true);
    try {
      await onRunManualCommand(toRun, cwdInput.trim() || '.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleAddPrefix = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPrefix.trim()) return;
    onAddAllowlist(newPrefix.trim());
    setNewPrefix('');
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

  const handleCopyScript = () => {
    navigator.clipboard.writeText(getLocalBridgeScript()).catch(() => {});
    setCopiedScript(true);
    setTimeout(() => setCopiedScript(false), 1800);
  };

  return (
    <div className="h-full overflow-y-auto px-6 py-6 bg-slate-50 dark:bg-[#0B0F17]">
      <div className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left: Command runner & execution history */}
        <div className="lg:col-span-8 space-y-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h1 className="text-lg font-semibold text-slate-950 dark:text-white">
                本机终端执行与进程控制
              </h1>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                通过伴侣隧道在本机执行验证命令，支持子目录切换、超时保护与远程终止进程。
              </p>
            </div>
            {commands.length > 0 && (
              <button
                type="button"
                onClick={onClearCommands}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-800 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>清空日志</span>
              </button>
            )}
          </div>

          {/* Manual Command Bar */}
          <form
            onSubmit={handleRun}
            className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] space-y-3"
          >
            <div className="flex flex-col sm:flex-row gap-2.5">
              <div className="flex-1 flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0F17] focus-within:border-blue-500">
                <Terminal className="w-4 h-4 text-slate-400 shrink-0" />
                <input
                  type="text"
                  value={cmdInput}
                  onChange={(e) => setCmdInput(e.target.value)}
                  disabled={!canRunShell}
                  placeholder={
                    canRunShell
                      ? '输入本机命令，例如 git status、npm test、npm run build'
                      : '请先在「控制台」绑定本机隧道（且未开启 --no-shell）'
                  }
                  className="w-full bg-transparent text-sm font-mono text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none disabled:opacity-60"
                />
              </div>
              <input
                type="text"
                value={cwdInput}
                onChange={(e) => setCwdInput(e.target.value)}
                disabled={!canRunShell}
                title="相对工作区执行目录"
                placeholder="cwd (.)"
                className="w-full sm:w-44 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0F17] text-xs font-mono text-slate-700 dark:text-slate-300 focus:outline-none focus:border-blue-500 disabled:opacity-60"
              />
              <button
                type="submit"
                disabled={!canRunShell || !cmdInput.trim() || submitting}
                className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 disabled:opacity-40 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Play className="w-3.5 h-3.5" />
                <span>运行</span>
              </button>
            </div>

            {canRunShell && gitRepos.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-slate-500 dark:text-slate-400">
                <span>快捷目录：</span>
                {['.', ...gitRepos.map((r) => r.path).filter((p) => p !== '.')].map((dir) => (
                  <button
                    key={dir}
                    type="button"
                    onClick={() => setCwdInput(dir)}
                    className={`px-2 py-0.5 rounded font-mono transition-colors cursor-pointer ${
                      cwdInput === dir
                        ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900'
                        : 'border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                    }`}
                  >
                    {dir}
                  </button>
                ))}
              </div>
            )}

            {!canRunShell && (
              <div className="flex items-center justify-between gap-3 pt-1 text-xs text-amber-700 dark:text-amber-400">
                <span>
                  {!connected
                    ? '当前尚未绑定本机伴侣隧道。'
                    : '当前本机脚本处于 --no-shell 或 --read-only 模式，已禁用 Shell 执行。'}
                </span>
                <button
                  type="button"
                  onClick={onGoConnect}
                  className="underline font-medium hover:text-amber-800 dark:hover:text-amber-300 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  返回控制台连接
                </button>
              </div>
            )}
          </form>

          {/* Command History */}
          {commands.length === 0 ? (
            <div className="p-10 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] text-center space-y-2">
              <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
                暂无命令执行记录
              </p>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                手动执行的本机命令以及通过伴侣触发的终端命令都会归档在这里，运行中的命令可随时点击终止。
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {commands.map((item) => {
                const statusText =
                  item.status === 'running'
                    ? '运行中'
                    : item.status === 'completed'
                      ? `完成 (exit ${item.exitCode ?? 0})`
                      : item.status === 'killed'
                        ? '已手动终止'
                        : item.status === 'rejected'
                          ? '已拒绝'
                          : `失败 (exit ${item.exitCode ?? -1})`;

                const statusColor =
                  item.status === 'completed'
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : item.status === 'running'
                      ? 'text-blue-600 dark:text-blue-400'
                      : item.status === 'rejected' || item.status === 'killed'
                        ? 'text-amber-600 dark:text-amber-400'
                        : 'text-rose-600 dark:text-rose-400';

                return (
                  <div
                    key={item.id}
                    className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] overflow-hidden"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 border-b border-slate-200 dark:border-slate-800">
                      <code className="text-[13px] font-mono font-medium text-slate-900 dark:text-slate-100 truncate">
                        {item.command}
                      </code>
                      <div className="flex items-center gap-2.5 text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
                        <span>{item.source === 'companion' ? '对话调用' : '手动'}</span>
                        <span aria-hidden="true">·</span>
                        <span>cwd: {item.cwd}</span>
                        <span aria-hidden="true">·</span>
                        <span className={statusColor}>{statusText}</span>
                        {typeof item.durationMs === 'number' && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>{item.durationMs}ms</span>
                          </>
                        )}
                        {item.status === 'running' && item.processId && (
                          <button
                            type="button"
                            onClick={() => onKillCommand(item)}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-rose-600 text-white text-[11px] hover:bg-rose-700 transition-colors cursor-pointer"
                          >
                            <Square className="w-3 h-3" />
                            <span>终止</span>
                          </button>
                        )}
                      </div>
                    </div>

                    {(item.stdout || item.stderr) && (
                      <div className="p-3.5 bg-slate-50 dark:bg-[#0B0F17] font-mono text-[12px] leading-relaxed overflow-x-auto max-h-72 overflow-y-auto space-y-2">
                        {item.stdout && (
                          <pre className="whitespace-pre-wrap text-slate-800 dark:text-slate-200">
                            {item.stdout}
                          </pre>
                        )}
                        {item.stderr && (
                          <pre className="whitespace-pre-wrap text-rose-600 dark:text-rose-400">
                            {item.stderr}
                          </pre>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Right: Safe Command Allowlist + Bridge v2.0 Script Download */}
        <div className="lg:col-span-4 space-y-5">
          <div className="p-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] space-y-4">
            <div>
              <h2 className="text-sm font-semibold text-slate-950 dark:text-white">
                安全白名单命令前缀
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
                切到「安全白名单」策略时，匹配下列前缀且不含管道/链式符（<code className="font-mono">; &amp;&amp; | $()</code>）的命令会自动放行，其余命令依然暂停等待审批。
              </p>
            </div>

            <form onSubmit={handleAddPrefix} className="flex gap-2">
              <input
                type="text"
                value={newPrefix}
                onChange={(e) => setNewPrefix(e.target.value)}
                placeholder="新增前缀，如 npm run test:layer"
                className="flex-1 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0F17] text-xs font-mono text-slate-900 dark:text-slate-100 focus:outline-none focus:border-blue-500"
              />
              <button
                type="submit"
                disabled={!newPrefix.trim()}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 text-xs font-medium hover:opacity-90 disabled:opacity-40 transition-opacity whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>添加</span>
              </button>
            </form>

            <div className="divide-y divide-slate-100 dark:divide-slate-800/80 border-t border-slate-200 dark:border-slate-800 max-h-[260px] overflow-y-auto">
              {allowlist.map((prefix) => (
                <div
                  key={prefix}
                  className="flex items-center justify-between py-2 text-xs font-mono text-slate-700 dark:text-slate-300"
                >
                  <span>{prefix}</span>
                  <button
                    type="button"
                    onClick={() => onRemoveAllowlist(prefix)}
                    title="移除该白名单前缀"
                    className="p-1 text-slate-400 hover:text-rose-500 transition-colors cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="p-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] space-y-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-950 dark:text-white">
                本机脚本 local-bridge.mjs v2.0
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
                零依赖 Node.js v20+ 单文件：支持 <code className="font-mono">--ngrok</code> / <code className="font-mono">--cloudflared</code> 单命令一键配对、多仓库只读 <code className="font-mono">git_inspect</code>、批量 <code className="font-mono">read_files</code>、<code className="font-mono">find_files</code> 及原子多处编辑。
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleDownloadScript}
                className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 transition-colors whitespace-nowrap cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                <span>下载脚本</span>
              </button>
              <button
                type="button"
                onClick={handleCopyScript}
                className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-medium transition-colors whitespace-nowrap cursor-pointer"
              >
                {copiedScript ? (
                  <Check className="w-3.5 h-3.5 text-emerald-500" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
                <span>{copiedScript ? '已复制' : '复制源码'}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
