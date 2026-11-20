import { useMemo } from 'react';
import { computeLineDiff, parseRawGitDiff } from '../lib/diff';

interface DiffViewerProps {
  before?: string;
  after?: string;
  rawGitDiff?: string;
  maxHeightClass?: string;
  emptyLabel?: string;
}

export function DiffViewer({
  before,
  after,
  rawGitDiff,
  maxHeightClass = 'max-h-[360px]',
  emptyLabel = '当前没有可展示的代码变更',
}: DiffViewerProps) {
  const lines = useMemo(() => {
    if (typeof rawGitDiff === 'string') {
      return parseRawGitDiff(rawGitDiff);
    }
    if (typeof before === 'string' && typeof after === 'string') {
      return computeLineDiff(before, after, 3);
    }
    return [];
  }, [before, after, rawGitDiff]);

  const stats = useMemo(() => {
    let adds = 0;
    let removes = 0;
    for (const line of lines) {
      if (line.type === 'add') adds++;
      if (line.type === 'remove') removes++;
    }
    return { adds, removes };
  }, [lines]);

  if (lines.length === 0) {
    return (
      <div className="px-4 py-8 text-center text-xs text-slate-500 dark:text-slate-400">
        {emptyLabel}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B0F17] overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-slate-200 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
        <span>Diff 变更明细</span>
        <div className="flex items-center gap-3">
          <span className="text-emerald-600 dark:text-emerald-400">+{stats.adds}</span>
          <span className="text-rose-600 dark:text-rose-400">-{stats.removes}</span>
        </div>
      </div>
      <div className={`overflow-auto font-mono text-[12px] leading-5 ${maxHeightClass}`}>
        <table className="w-full border-collapse">
          <tbody>
            {lines.map((line, index) => {
              const rowClass =
                line.type === 'add'
                  ? 'bg-emerald-50/90 dark:bg-emerald-950/35 text-emerald-950 dark:text-emerald-200'
                  : line.type === 'remove'
                    ? 'bg-rose-50/90 dark:bg-rose-950/35 text-rose-950 dark:text-rose-200'
                    : line.type === 'meta'
                      ? 'bg-slate-100/80 dark:bg-slate-900/90 text-slate-500 dark:text-slate-400'
                      : 'text-slate-700 dark:text-slate-300';

              const marker =
                line.type === 'add'
                  ? '+'
                  : line.type === 'remove'
                    ? '-'
                    : line.type === 'meta'
                      ? ' '
                      : ' ';

              return (
                <tr key={index} className={rowClass}>
                  <td className="w-10 px-2 py-0.5 text-right select-none text-slate-400 dark:text-slate-600 border-r border-slate-200/70 dark:border-slate-800/70 tabular-nums">
                    {line.oldLine ?? ''}
                  </td>
                  <td className="w-10 px-2 py-0.5 text-right select-none text-slate-400 dark:text-slate-600 border-r border-slate-200/70 dark:border-slate-800/70 tabular-nums">
                    {line.newLine ?? ''}
                  </td>
                  <td className="w-5 px-1.5 py-0.5 text-center select-none font-semibold">
                    {marker}
                  </td>
                  <td className="pr-4 py-0.5 whitespace-pre">{line.text}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
