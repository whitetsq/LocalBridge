import { ChevronDown, ChevronRight, FileCode2, Folder, FolderOpen } from 'lucide-react';
import type { FileNode } from '../types/agent';

interface FileTreeProps {
  nodes: FileNode[];
  expandedPaths: Set<string>;
  selectedPath?: string;
  filterQuery: string;
  onToggleDir: (path: string) => void;
  onSelectFile: (path: string) => void;
}

function filterTree(nodes: FileNode[], query: string): FileNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return nodes;
  const result: FileNode[] = [];

  for (const node of nodes) {
    if (node.type === 'file') {
      if (node.name.toLowerCase().includes(q) || node.path.toLowerCase().includes(q)) {
        result.push(node);
      }
    } else {
      const filteredChildren = node.children ? filterTree(node.children, q) : [];
      if (node.name.toLowerCase().includes(q) || filteredChildren.length > 0) {
        result.push({
          ...node,
          children: filteredChildren,
        });
      }
    }
  }
  return result;
}

function TreeBranch({
  nodes,
  depth,
  expandedPaths,
  selectedPath,
  forceExpand,
  onToggleDir,
  onSelectFile,
}: {
  nodes: FileNode[];
  depth: number;
  expandedPaths: Set<string>;
  selectedPath?: string;
  forceExpand: boolean;
  onToggleDir: (path: string) => void;
  onSelectFile: (path: string) => void;
}) {
  return (
    <div>
      {nodes.map((node) => {
        const isDir = node.type === 'dir';
        const isExpanded = isDir && (forceExpand || expandedPaths.has(node.path));
        const isSelected = !isDir && selectedPath === node.path;

        return (
          <div key={node.path}>
            <button
              type="button"
              onClick={() => (isDir ? onToggleDir(node.path) : onSelectFile(node.path))}
              style={{ paddingLeft: `${depth * 14 + 10}px` }}
              className={`w-full flex items-center gap-1.5 pr-2.5 py-1.5 text-left text-[13px] rounded-md transition-colors cursor-pointer ${
                isSelected
                  ? 'bg-blue-600/10 dark:bg-blue-500/15 text-blue-700 dark:text-blue-300 font-medium'
                  : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/70'
              }`}
              title={node.path}
            >
              {isDir ? (
                <>
                  {isExpanded ? (
                    <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                  ) : (
                    <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                  )}
                  {isExpanded ? (
                    <FolderOpen className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400 shrink-0" />
                  ) : (
                    <Folder className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400 shrink-0" />
                  )}
                </>
              ) : (
                <>
                  <span className="w-3.5 shrink-0" />
                  <FileCode2 className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500 shrink-0" />
                </>
              )}
              <span className="truncate font-mono text-[12.5px]">{node.name}</span>
            </button>

            {isDir && isExpanded && node.children && node.children.length > 0 && (
              <TreeBranch
                nodes={node.children}
                depth={depth + 1}
                expandedPaths={expandedPaths}
                selectedPath={selectedPath}
                forceExpand={forceExpand}
                onToggleDir={onToggleDir}
                onSelectFile={onSelectFile}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

export function FileTree({
  nodes,
  expandedPaths,
  selectedPath,
  filterQuery,
  onToggleDir,
  onSelectFile,
}: FileTreeProps) {
  const filtered = filterTree(nodes, filterQuery);

  if (filtered.length === 0) {
    return (
      <div className="px-3 py-6 text-center text-xs text-slate-500 dark:text-slate-400">
        {filterQuery.trim() ? '未找到匹配的文件' : '目录为空'}
      </div>
    );
  }

  return (
    <TreeBranch
      nodes={filtered}
      depth={0}
      expandedPaths={expandedPaths}
      selectedPath={selectedPath}
      forceExpand={filterQuery.trim().length > 0}
      onToggleDir={onToggleDir}
      onSelectFile={onSelectFile}
    />
  );
}
