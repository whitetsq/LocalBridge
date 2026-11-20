export type SecurityPolicy = 'approve' | 'allowlist' | 'readonly';

export type MainView = 'companion' | 'code' | 'terminal';

export type InspectorTab = 'file' | 'diff';

export interface GitRepoSummary {
  path: string;
  name: string;
  branch?: string;
  dirtyCount?: number;
}

export interface CompanionWorkspaceInfo {
  name: string;
  rootPath: string;
  noShell: boolean;
  readOnly: boolean;
  version?: string;
  branch?: string;
  dirtyCount?: number;
  stack?: string[];
  gitRepos?: GitRepoSummary[];
}

export interface CompanionEventItem {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  status: 'pending_approval' | 'running' | 'success' | 'error' | 'rejected';
  source: 'companion-chat' | 'ui';
  startedAt: number;
  durationMs?: number;
  result?: Record<string, unknown>;
  error?: string;
  previewBefore?: string;
  previewAfter?: string;
  filePath?: string;
  command?: string;
}

export interface CompanionPendingApprovalItem {
  id: string;
  eventId: string;
  toolName: string;
  args: Record<string, unknown>;
  filePath?: string;
  command?: string;
  previewBefore?: string;
  previewAfter?: string;
  createdAt: number;
}

export interface CompanionPublicState {
  connected: boolean;
  tunnelUrl: string;
  workspace: CompanionWorkspaceInfo | null;
  policy: SecurityPolicy;
  autoApproveFileWrites: boolean;
  allowlist: string[];
  events: CompanionEventItem[];
  pendingApprovals: CompanionPendingApprovalItem[];
}

export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size?: number;
  children?: FileNode[];
  loaded?: boolean;
}

export interface OpenFileState {
  path: string;
  content: string;
  totalLines: number;
  truncated?: boolean;
  loading?: boolean;
  error?: string;
}

export interface CommandRecord {
  id: string;
  processId?: string;
  command: string;
  cwd: string;
  status: 'running' | 'completed' | 'failed' | 'killed' | 'rejected';
  exitCode?: number | null;
  stdout: string;
  stderr: string;
  durationMs?: number;
  startedAt: number;
  source: 'companion' | 'manual';
}

export interface PendingApproval {
  id: string;
  turnId: string;
  toolName: string;
  args: Record<string, unknown>;
  reason: string;
  previewBefore?: string;
  previewAfter?: string;
  filePath?: string;
  command?: string;
  resolve: (decision: {
    approved: boolean;
    note?: string;
    addAllowlistPrefix?: string;
  }) => void;
}
