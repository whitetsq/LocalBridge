import React, { useState } from 'react';
import {
  Check,
  Copy,
  Download,
  FolderOpen,
  Plug,
  RefreshCw,
  ShieldCheck,
  Unplug,
} from 'lucide-react';
import { getLocalBridgeScript } from '../lib/bridgeScriptTemplate';
import { supportsChromeDirectoryPicker } from '../lib/localClient';
import type { BridgeConfig, ConnectionMode, WorkspaceSummary } from '../types/agent';

interface BridgeSetupViewProps {
  config: BridgeConfig;
  connectionMode: ConnectionMode;
  workspace: WorkspaceSummary | null;
  connecting: boolean;
  connectionError: string | null;
  onChangeConfig: (next: BridgeConfig) => void;
  onConnectBridge: () => Promise<void>;
  onConnectBrowserFolder: () => Promise<void>;
  onDisconnect: () => void;
  onBackToWorkbench: () => void;
}

export function BridgeSetupView({
  config,
  connectionMode,
  workspace,
  connecting,
  connectionError,
  onChangeConfig,
  onConnectBridge,
  onConnectBrowserFolder,
  onDisconnect,
  onBackToWorkbench,
}: BridgeSetupViewProps) {
  const [osTab, setOsTab] = useState<'unix' | 'windows'>('unix');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [showScriptPreview, setShowScriptPreview] = useState(false);

  const canUseBrowserPicker = supportsChromeDirectoryPicker();

  const copyText = (id: string, text: string) => {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1800);
  };

  const handleDownloadScript = () => {
    const content = getLocalBridgeScript();
    const blob = new Blob([content], { type: 'application/javascript;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'local-bridge.mjs';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const startCmd =
    osTab === 'unix'
      ? 'cd /path/to/your-project\nnode ~/Downloads/local-bridge.mjs setup'
      : 'cd C:\\path\\to\\your-project\nnode %USERPROFILE%\\Downloads\\local-bridge.mjs setup';

  const safeStartCmd =
    osTab === 'unix'
      ? 'node ~/Downloads/local-bridge.mjs --read-only --port 4829'
      : 'node %USERPROFILE%\\Downloads\\local-bridge.mjs --read-only --port 4829';

  const mcpTunnelSnippet = `# 可选：如需接入 ChatGPT 开发者模式等外部云端 MCP 客户端
cloudflared tunnel --url http://127.0.0.1:4829

# 然后将外部客户端的 MCP Server URL 设为：
# https://<你的随机隧道域名>/mcp/<终端里的安全Token>`;

  const handleSubmitConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    await onConnectBridge();
  };

  return (
    <div className="h-full overflow-y-auto px-6 py-6">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Header Summary */}
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-5">
          <div className="space-y-1">
            <h1 className="text-xl font-semibold text-slate-950 dark:text-white tracking-tight">
              本机桥接脚本与 MCP 连接配置
            </h1>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              通过 Chrome 直连本机 <code className="font-mono text-xs">127.0.0.1</code>，无需公网暴露即可让 AI 读取项目、发起 Diff 审批并执行验证命令。
            </p>
          </div>
          {connectionMode !== 'disconnected' && workspace && (
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={onBackToWorkbench}
                className="px-4 py-2 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                返回工作台
              </button>
              <button
                type="button"
                onClick={onDisconnect}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Unplug className="w-3.5 h-3.5" />
                <span>断开连接</span>
              </button>
            </div>
          )}
        </div>

        {/* Active Connection Banner (if connected) */}
        {connectionMode !== 'disconnected' && workspace && (
          <div className="p-4 rounded-xl border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50/70 dark:bg-emerald-950/25 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3 text-sm">
              <ShieldCheck className="w-5 h-5 text-emerald-600 dark:text-emerald-400 shrink-0" />
              <div className="space-y-0.5">
                <div className="font-medium text-emerald-950 dark:text-emerald-200">
                  已连接工作区：{workspace.name}
                </div>
                <div className="text-xs text-emerald-800/80 dark:text-emerald-300/80 font-mono flex flex-wrap items-center gap-2">
                  <span>{connectionMode === 'bridge' ? 'LocalBridge 本机服务' : 'Chrome 本地目录直连'}</span>
                  <span aria-hidden="true">·</span>
                  <span>{workspace.rootPath}</span>
                  <span aria-hidden="true">·</span>
                  <span>{workspace.noShell ? '终端命令已禁用' : '终端命令已就绪'}</span>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left Column: 3-Step LocalBridge Setup */}
          <div className="lg:col-span-7 space-y-5">
            <section className="p-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] space-y-5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-slate-950 dark:text-white">
                    方式一：LocalBridge 本机代理（完整支持文件读写 + 终端命令 + MCP）
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                    零第三方依赖单文件脚本，要求本机已安装 Node.js v20+。
                  </p>
                </div>
              </div>

              {/* Step 1 */}
              <div className="space-y-2.5 pt-2 border-t border-slate-100 dark:border-slate-800/80">
                <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                  01. 下载单文件本机脚本
                </div>
                <div className="flex flex-wrap items-center gap-2.5">
                  <button
                    type="button"
                    onClick={handleDownloadScript}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 text-xs font-medium hover:opacity-90 transition-opacity whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>下载 local-bridge.mjs</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowScriptPreview((v) => !v)}
                    className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    {showScriptPreview ? '收起源码审查' : '审查脚本源码'}
                  </button>
                </div>
                {showScriptPreview && (
                  <pre className="mt-2 p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0B0F17] text-[11.5px] font-mono text-slate-700 dark:text-slate-300 max-h-64 overflow-auto">
                    {getLocalBridgeScript()}
                  </pre>
                )}
              </div>

              {/* Step 2 */}
              <div className="space-y-2.5 pt-3 border-t border-slate-100 dark:border-slate-800/80">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                    02. 在你的目标代码仓库根目录启动
                  </span>
                  <div className="inline-flex items-center p-0.5 rounded-lg bg-slate-100 dark:bg-slate-800/90">
                    <button
                      type="button"
                      onClick={() => setOsTab('unix')}
                      className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors cursor-pointer ${
                        osTab === 'unix'
                          ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-xs'
                          : 'text-slate-600 dark:text-slate-400'
                      }`}
                    >
                      macOS / Linux
                    </button>
                    <button
                      type="button"
                      onClick={() => setOsTab('windows')}
                      className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors cursor-pointer ${
                        osTab === 'windows'
                          ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-xs'
                          : 'text-slate-600 dark:text-slate-400'
                      }`}
                    >
                      Windows
                    </button>
                  </div>
                </div>

                <div className="relative rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0B0F17] p-3 font-mono text-xs text-slate-800 dark:text-slate-200">
                  <pre className="whitespace-pre-wrap pr-16">{startCmd}</pre>
                  <button
                    type="button"
                    onClick={() => copyText('start', startCmd)}
                    className="absolute top-2.5 right-2.5 inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] text-slate-600 dark:text-slate-300 hover:bg-slate-200/70 dark:hover:bg-slate-800 transition-colors cursor-pointer"
                  >
                    {copiedId === 'start' ? (
                      <Check className="w-3.5 h-3.5 text-emerald-500" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                    <span>{copiedId === 'start' ? '已复制' : '复制'}</span>
                  </button>
                </div>

                <div className="text-xs text-slate-500 dark:text-slate-400 flex flex-wrap items-center gap-2">
                  <span>只读禁命令安全启动参数：</span>
                  <code className="font-mono text-[11.5px] text-slate-700 dark:text-slate-300">
                    {safeStartCmd}
                  </code>
                </div>
              </div>

              {/* Step 3: External MCP Info */}
              <div className="space-y-2.5 pt-3 border-t border-slate-100 dark:border-slate-800/80">
                <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                  03. 兼容标准 MCP 协议（支持后续对接 ChatGPT 开发者模式 / Cursor）
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                  在当前 AI Studio 控制台中使用时无需内网穿透；如果未来你想把同一个本机仓库接入外部云端 MCP 客户端（如 ChatGPT 网页端开发者模式），脚本已内置 <code className="font-mono">/mcp</code> JSON-RPC 2.0 端点：
                </p>
                <div className="relative rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0B0F17] p-3 font-mono text-[11.5px] text-slate-700 dark:text-slate-300">
                  <pre className="whitespace-pre-wrap pr-14">{mcpTunnelSnippet}</pre>
                  <button
                    type="button"
                    onClick={() => copyText('mcp', mcpTunnelSnippet)}
                    className="absolute top-2.5 right-2.5 inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] text-slate-600 dark:text-slate-300 hover:bg-slate-200/70 dark:hover:bg-slate-800 transition-colors cursor-pointer"
                  >
                    {copiedId === 'mcp' ? (
                      <Check className="w-3.5 h-3.5 text-emerald-500" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                    <span>{copiedId === 'mcp' ? '已复制' : '复制'}</span>
                  </button>
                </div>
              </div>
            </section>
          </div>

          {/* Right Column: Connection Form + Chrome Direct Folder Alternative */}
          <div className="lg:col-span-5 space-y-5">
            <form
              onSubmit={handleSubmitConnect}
              className="p-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] space-y-4"
            >
              <div>
                <h2 className="text-sm font-semibold text-slate-950 dark:text-white">
                  连接到本机 Bridge
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                  将终端启动后打印的本地地址与随机安全 Token 填入下方即可握手连接。
                </p>
              </div>

              <div className="space-y-3">
                <label className="block space-y-1.5">
                  <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
                    本机地址
                  </span>
                  <input
                    type="text"
                    value={config.url}
                    onChange={(e) => onChangeConfig({ ...config, url: e.target.value })}
                    placeholder="http://127.0.0.1:4829"
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0F17] text-xs font-mono text-slate-900 dark:text-slate-100 focus:outline-none focus:border-blue-500"
                  />
                </label>

                <label className="block space-y-1.5">
                  <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
                    安全 Token（X-Bridge-Token）
                  </span>
                  <input
                    type="password"
                    value={config.token}
                    onChange={(e) => onChangeConfig({ ...config, token: e.target.value })}
                    placeholder="粘贴终端输出的一次性 Token"
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0F17] text-xs font-mono text-slate-900 dark:text-slate-100 focus:outline-none focus:border-blue-500"
                  />
                </label>
              </div>

              {connectionError && (
                <div className="p-3 rounded-lg border border-rose-200 dark:border-rose-900/60 bg-rose-50 dark:bg-rose-950/30 text-xs text-rose-700 dark:text-rose-300 leading-relaxed">
                  {connectionError}
                </div>
              )}

              <button
                type="submit"
                disabled={connecting || !config.url.trim() || !config.token.trim()}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 disabled:opacity-45 transition-colors cursor-pointer"
              >
                {connecting ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Plug className="w-3.5 h-3.5" />
                )}
                <span>{connecting ? '正在校验握手...' : '测试并连接本机仓库'}</span>
              </button>

              <p className="text-[11.5px] text-slate-500 dark:text-slate-400 leading-relaxed">
                Chrome 提示：如果预览位于内嵌 iframe 中导致浏览器限制访问 <code className="font-mono">127.0.0.1</code>，请点击右上角在新标签页中打开本应用。
              </p>
            </form>

            {/* Alternative: Zero-install Chrome Local Folder Picker */}
            <section className="p-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] space-y-3">
              <div>
                <h2 className="text-sm font-semibold text-slate-950 dark:text-white">
                  方式二：Chrome 零脚本直连本地文件夹
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
                  如果暂时不想启动 Node.js 脚本，可直接授权 Chrome 打开本机目录，支持真实代码读写、搜索和 Diff 审批（不包含终端命令执行）。
                </p>
              </div>
              <button
                type="button"
                onClick={onConnectBrowserFolder}
                disabled={!canUseBrowserPicker || connecting}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-45 transition-colors cursor-pointer"
              >
                <FolderOpen className="w-4 h-4" />
                <span>
                  {canUseBrowserPicker ? '选择本机文件夹立即体验' : '当前浏览器不支持目录直连'}
                </span>
              </button>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
