import { useState } from 'react';
import { Check, FileDiff, ShieldAlert, Terminal, Trash2, X } from 'lucide-react';
import { DiffViewer } from './DiffViewer';
import { suggestAllowlistPrefix } from '../lib/localClient';
import type { PendingApproval } from '../types/agent';

interface ApprovalCardProps {
  approval: PendingApproval;
}

export function ApprovalCard({ approval }: ApprovalCardProps) {
  const [rejectNote, setRejectNote] = useState('');

  const isCommand = approval.toolName === 'run_command';
  const isDelete = approval.toolName === 'delete_file';
  const isCreateDir = approval.toolName === 'create_directory';
  const isMove = approval.toolName === 'move_path';
  const suggestedPrefix =
    isCommand && approval.command ? suggestAllowlistPrefix(approval.command) : undefined;

  const title = isCommand
    ? '请求执行本机终端命令'
    : isDelete
      ? '请求删除本地文件'
      : isCreateDir
        ? '请求新建本地文件夹'
        : isMove
          ? '请求移动 / 重命名路径'
          : approval.toolName === 'write_file'
            ? '请求写入本地文件'
            : '请求修改本地文件';

  return (
    <div className="my-3 rounded-xl border border-amber-300/80 dark:border-amber-700/60 bg-amber-50/40 dark:bg-amber-950/15 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 border-b border-amber-200/80 dark:border-amber-800/50">
        <div className="flex items-center gap-2 text-xs font-semibold text-amber-900 dark:text-amber-200">
          {isCommand ? (
            <Terminal className="w-4 h-4 shrink-0" />
          ) : isDelete ? (
            <Trash2 className="w-4 h-4 shrink-0 text-rose-600 dark:text-rose-400" />
          ) : (
            <FileDiff className="w-4 h-4 shrink-0" />
          )}
          <span>{title}</span>
          {approval.filePath && (
            <>
              <span aria-hidden="true" className="text-amber-500">·</span>
              <code className="font-mono font-medium text-slate-900 dark:text-slate-100">
                {approval.filePath}
              </code>
            </>
          )}
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-amber-800/90 dark:text-amber-300/90">
          <ShieldAlert className="w-3.5 h-3.5" />
          <span>等待人工审批</span>
        </div>
      </div>

      <div className="p-4 space-y-3">
        {isCommand && approval.command && (
          <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B0F17] font-mono text-xs space-y-1">
            <div className="text-slate-900 dark:text-slate-100 break-all">$ {approval.command}</div>
            {Boolean(approval.args.cwd) && (
              <div className="text-[11px] text-slate-500 dark:text-slate-400">
                cwd: {String(approval.args.cwd)}
              </div>
            )}
          </div>
        )}

        {isMove && (
          <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B0F17] font-mono text-xs text-slate-800 dark:text-slate-200 space-y-1">
            <div>源路径：{String(approval.args.from || '')}</div>
            <div>目标路径：{String(approval.args.to || '')}</div>
          </div>
        )}

        {isCreateDir && approval.filePath && (
          <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B0F17] font-mono text-xs text-slate-800 dark:text-slate-200">
            新建目录：{approval.filePath}
          </div>
        )}

        {isDelete && approval.filePath && (
          <div className="p-3 rounded-lg border border-rose-200 dark:border-rose-900/60 bg-rose-50/70 dark:bg-rose-950/30 text-xs text-rose-700 dark:text-rose-300">
            此操作将从你本机磁盘删除文件 <code className="font-mono font-semibold">{approval.filePath}</code>，删除后不可直接撤销。
          </div>
        )}

        {typeof approval.previewBefore === 'string' && typeof approval.previewAfter === 'string' && (
          <DiffViewer
            before={approval.previewBefore}
            after={approval.previewAfter}
            maxHeightClass="max-h-64"
            emptyLabel="文件内容无变化"
          />
        )}

        <div className="flex flex-col sm:flex-row sm:items-center gap-2 pt-1">
          <input
            type="text"
            value={rejectNote}
            onChange={(e) => setRejectNote(e.target.value)}
            placeholder="可选：如果拒绝，可给 AI 留一句修改建议"
            className="flex-1 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:border-blue-500"
          />
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => approval.resolve({ approved: true })}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Check className="w-3.5 h-3.5" />
              <span>允许执行</span>
            </button>
            {isCommand && suggestedPrefix && (
              <button
                type="button"
                onClick={() =>
                  approval.resolve({ approved: true, addAllowlistPrefix: suggestedPrefix })
                }
                title={`本次执行并将 "${suggestedPrefix}" 加入安全白名单`}
                className="px-3 py-1.5 rounded-lg border border-emerald-600/40 text-emerald-700 dark:text-emerald-300 bg-emerald-500/10 hover:bg-emerald-500/20 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                放行并加入白名单 ({suggestedPrefix})
              </button>
            )}
            <button
              type="button"
              onClick={() =>
                approval.resolve({
                  approved: false,
                  note: rejectNote.trim() || undefined,
                })
              }
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
              <span>拒绝</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
