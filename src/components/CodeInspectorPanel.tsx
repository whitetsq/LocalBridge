import { Check, Copy, FileCode2, GitBranch, GitCompare, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { DiffViewer } from './DiffViewer';
import type { GitRepoSummary, OpenFileState } from '../types/agent';

interface CodeInspectorPanelProps {
  mode: 'file' | 'diff';
  connected: boolean;
  openFile: OpenFileState | null;
  gitRepos: GitRepoSummary[];
  selectedGitRepo: string;
  onSelectGitRepo: (repoPath: string) => void;
  gitDiffText: string;
  gitStatusText: string;
  gitLogText: string;
  diffLoading: boolean;
  onRefreshDiff: () => Promise<void>;
  fullHeight?: boolean;
}

export function CodeInspectorPanel({
  mode,
  connected,
  openFile,
  gitRepos,
  selectedGitRepo,
  onSelectGitRepo,
  gitDiffText,
  gitStatusText,
  gitLogText,
  diffLoading,
  onRefreshDiff,
  fullHeight = false,
}: CodeInspectorPanelProps) {
  const [copied, setCopied] = useState(false);

  const handleCopyFile = () => {
    if (!openFile?.content) return;
    navigator.clipboard.writeText(openFile.content).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  if (mode === 'diff') {
    return (
      <div className="h-full flex flex-col min-h-0">
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 border-b border-slate-200 dark:border-slate-800 shrink-0">
          <div className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300 min-w-0">
            <GitCompare className="w-3.5 h-3.5 shrink-0 text-slate-400" />
            <span className="font-medium truncate">Git 仓库变更</span>
            {gitRepos.length > 0 && (
              <select
                value={selectedGitRepo}
                onChange={(e) => onSelectGitRepo(e.target.value)}
                aria-label="选择 Git 子仓库"
                className="ml-1 px-2 py-0.5 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0F17] text-[11.5px] font-mono text-slate-800 dark:text-slate-200 focus:outline-none focus:border-blue-500 cursor-pointer"
              >
                {gitRepos.map((repo) => (
                  <option key={repo.path} value={repo.path}>
                    {repo.path === '.' ? repo.name : repo.path}
                    {repo.branch ? ` (${repo.branch})` : ''}
                  </option>
                ))}
              </select>
            )}
          </div>
          <button
            type="button"
            onClick={onRefreshDiff}
            disabled={!connected || diffLoading}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${diffLoading ? 'animate-spin' : ''}`} />
            <span>刷新</span>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {!connected ? (
            <div className="py-12 text-center text-xs text-slate-500 dark:text-slate-400">
              绑定本机隧道后，可在此实时审查多仓库 Git 状态、未提交 Diff 与最近提交记录。
            </div>
          ) : (
            <>
              {gitStatusText && (
                <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0B0F17] font-mono text-[11.5px] text-slate-700 dark:text-slate-300 whitespace-pre-wrap">
                  {gitStatusText}
                </div>
              )}

              <DiffViewer
                rawGitDiff={gitDiffText}
                maxHeightClass={fullHeight ? 'max-h-[55vh]' : 'max-h-[45vh]'}
                emptyLabel="当前仓库暂无未提交的 Git Diff 改动"
              />

              {gitLogText && (
                <div className="space-y-1.5 pt-2">
                  <div className="flex items-center gap-1.5 text-[11.5px] font-medium text-slate-500 dark:text-slate-400">
                    <GitBranch className="w-3.5 h-3.5" />
                    <span>最近提交</span>
                  </div>
                  <pre className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0B0F17] font-mono text-[11.5px] leading-relaxed text-slate-700 dark:text-slate-300 overflow-x-auto whitespace-pre">
                    {gitLogText}
                  </pre>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-slate-200 dark:border-slate-800 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <FileCode2 className="w-3.5 h-3.5 text-slate-400 shrink-0" />
          <span
            className="text-xs font-mono font-medium text-slate-800 dark:text-slate-200 truncate"
            title={openFile?.path}
          >
            {openFile ? openFile.path : '未选择文件'}
          </span>
          {openFile && !openFile.loading && !openFile.error && (
            <span className="text-[11px] font-mono tabular-nums text-slate-400 shrink-0">
              · {openFile.totalLines} 行
            </span>
          )}
        </div>

        {openFile && !openFile.loading && !openFile.error && (
          <button
            type="button"
            onClick={handleCopyFile}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {copied ? (
              <Check className="w-3.5 h-3.5 text-emerald-500" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
            <span>{copied ? '已复制' : '复制'}</span>
          </button>
        )}
      </div>

      <div className="flex-1 overflow-auto bg-slate-50/70 dark:bg-[#0B0F17]">
        {!openFile ? (
          <div className="h-full flex flex-col items-center justify-center px-6 text-center space-y-2">
            <p className="text-xs font-medium text-slate-600 dark:text-slate-300">
              从左侧目录树点击文件即可预览源码
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              左侧对话框读取或修改过的文件也可以在审计流中点击「预览」快速定位。
            </p>
          </div>
        ) : openFile.loading ? (
          <div className="p-4 space-y-2">
            <div className="h-4 w-2/3 rounded bg-slate-200 dark:bg-slate-800 animate-pulse" />
            <div className="h-4 w-5/6 rounded bg-slate-200 dark:bg-slate-800 animate-pulse" />
            <div className="h-4 w-1/2 rounded bg-slate-200 dark:bg-slate-800 animate-pulse" />
          </div>
        ) : openFile.error ? (
          <div className="p-4 text-xs text-rose-600 dark:text-rose-400">{openFile.error}</div>
        ) : (
          <div className="font-mono text-[12px] leading-5 py-2">
            <table className="w-full border-collapse">
              <tbody>
                {openFile.content.split(/\r?\n/).map((line, idx) => (
                  <tr key={idx} className="hover:bg-slate-200/40 dark:hover:bg-slate-800/40">
                    <td className="w-12 px-3 py-0.5 text-right select-none text-slate-400 dark:text-slate-600 border-r border-slate-200/70 dark:border-slate-800/70 tabular-nums align-top">
                      {idx + 1}
                    </td>
                    <td className="pl-3 pr-4 py-0.5 whitespace-pre text-slate-800 dark:text-slate-200">
                      {line}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {openFile.truncated && (
              <div className="px-4 py-2 text-xs text-amber-600 dark:text-amber-400 border-t border-slate-200 dark:border-slate-800 mt-2">
                文件内容较长，当前仅展示前 500 行预览。
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
