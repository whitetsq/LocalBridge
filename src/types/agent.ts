export type SecurityPolicy = 'approve' | 'allowlist' | 'readonly';

export type ConnectionMode = 'disconnected' | 'bridge' | 'browser-fs';

export type ReasoningLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export type MainView = 'workbench' | 'code' | 'terminal' | 'setup';

export type InspectorTab = 'file' | 'diff' | 'commands';

export interface BridgeConfig {
  url: string;
  token: string;
}

export interface WorkspaceSummary {
  name: string;
  rootPath: string;
  mode: ConnectionMode;
  noShell: boolean;
  branch?: string;
  dirtyCount?: number;
  stack?: string[];
  scripts?: Record<string, string>;
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
  source: 'agent' | 'manual';
}

export interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: {
    id?: string;
    name: string;
    args?: Record<string, unknown>;
  };
  functionResponse?: {
    id?: string;
    name: string;
    response: Record<string, unknown>;
  };
}

export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

export interface ToolExecutionTrace {
  id: string;
  callId?: string;
  name: string;
  args: Record<string, unknown>;
  status: 'pending_approval' | 'running' | 'success' | 'error' | 'rejected';
  result?: Record<string, unknown>;
  error?: string;
  durationMs?: number;
  previewBefore?: string;
  previewAfter?: string;
}

export interface ChatTurn {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  timestamp: number;
  tools?: ToolExecutionTrace[];
  error?: string;
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

export interface SessionDiffEntry {
  path: string;
  before: string;
  after: string;
  updatedAt: number;
}
