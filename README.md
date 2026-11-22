# LocalBridge

**AI 对话伴侣控制台 & 零依赖本地工作区 MCP 桥接** — 让云端 AI 对话安全地读取、搜索、审查多仓库 Git、修改本地代码并实时流式执行终端命令，同时通过浏览器可视化控制面实现**逐行红绿 Diff 审批、一键回滚、安全策略热切换与隧道心跳监管**，全程无需将密钥粘贴进聊天记录。

---

## 核心架构

```text
AI 对话 / Companion CLI (scripts/companion.mjs)
        │
        ▼
LocalBridge 控制面 (server.ts, 仅内存暂存隧道与 Token)
        ├── SSE 实时推送 ──▶ 浏览器可视化控制台（目录树 / 代码预览 / 多仓库 Git Diff / 审批 / 流式终端 / 一键回滚）
        └── HTTPS 隧道 ────▶ 本机 local-bridge.mjs (严格绑定 127.0.0.1:4829)
```

---

## 核心特性（v2.1）

- **单命令启动 + 一键配对**：`local-bridge.mjs` 内置 `--ngrok` / `--cloudflared` 启动器，自动拉起隧道并输出单行配对串 `https://<tunnel>#token=<secret>`；前端粘贴即可自动拆分填入，并通过 `sessionStorage` 支持刷新后一键重连。
- **14 项工程级本地工具（含多仓库 Git）**：
  - 只读探索：`inspect_workspace`（自动发现根与子目录多 Git 仓库）、`list_directory`、`find_files`、`read_file`、`read_files`（单次往返批量读）、`search_files`（扩展名过滤 + 正则 + 上下文行）、`git_inspect`（纯只读 `execFile('git', ...)`，支持指定子仓库 `cwd` 查 `status / diff / staged_diff / log / branches / show`）、`git_diff`。
  - 受控写入与执行：`edit_file`（支持原子多处替换）、`write_file`、`delete_file`、`create_directory`、`move_path`、`run_command`（支持 NDJSON 实时流式 stdout/stderr 与进程树终止）。
- **纵深安全防线**：
  - **三级热切换策略**：`逐条审批`（改文件先看逐行 Diff，支持 `Ctrl/Cmd+Enter` 允许、`Esc` 拒绝与「允许并加入白名单」）、`安全白名单`、`只读模式`。
  - **改前自动快照 & 一键回滚**：每次 `edit_file` / `write_file` / `delete_file` 落盘前自动备份原文，审计流中点击「回滚」立即还原。
  - **敏感文件物理拦截**：本机脚本默认禁止读写 `.env*`（放行 `.env.example`）、SSH 私钥（`id_rsa` / `id_ed25519`）、`*.pem`、`*.key`、`credentials.json` 等文件，防止误读进云端对话上下文。
  - **常量时间 Token 校验 & 路径沙箱**：`crypto.timingSafeEqual` 校验高熵随机 Token，`path.resolve` + `fs.realpath` 防止目录穿越与软链接逃逸。
- **实时流式终端 + 心跳探活**：编译与测试日志实时逐行滚动展示，支持远程终止进程树；每 30 秒自动探活隧道延迟与在线状态。
- **兼容标准 MCP 协议**：`local-bridge.mjs` 同时暴露 MCP JSON-RPC 2.0 端点（`POST /mcp` 与 `POST /mcp/<token>`），可供任意外部 MCP 客户端复用。

---

## 快速上手

### 1. 启动控制面服务

环境要求：Node.js `v20+`。

```bash
npm install
npm run dev
```

生产构建与运行：

```bash
npm run build
NODE_ENV=production npm start
```

访问 `http://localhost:3000` 打开 LocalBridge 控制台。

### 2. 在本机目标仓库启动 `local-bridge.mjs`

从控制台下载 `local-bridge.mjs` 后，只需**一个终端**即可同时启动本机代理与公网隧道：

```bash
# 使用 ngrok 自动拉起隧道并生成一键配对串
node local-bridge.mjs --ngrok --root "/path/to/your-workspace"

# 或使用 cloudflared
node local-bridge.mjs --cloudflared --root "/path/to/your-workspace"

# 或运行交互式向导（自选目录、权限级别与隧道方式）
node local-bridge.mjs setup
```

复制终端打印的 `https://...#token=...` 粘贴到控制面顶部输入框，点击 **「绑定隧道并开启实时监管」** 即可。

### 3. 通过 Companion CLI 调用本机工具

```bash
node scripts/companion.mjs status
node scripts/companion.mjs tree . 2
node scripts/companion.mjs git status <subdir>
node scripts/companion.mjs find "**/*.ts" src
node scripts/companion.mjs read package.json:1-60 README.md:1-80
node scripts/companion.mjs call run_command '{"command":"npm test","cwd":"."}'
```

---

## 命令行安全选项（`local-bridge.mjs`）

| 参数 | 说明 |
| :--- | :--- |
| `--root <dir>` | 限定可访问的根目录（默认当前工作目录） |
| `--port <num>` | 本机监听端口（默认 `4829`，严格绑定 `127.0.0.1`） |
| `--token <str>` | 固定访问令牌（默认每次启动随机生成 48 位密钥） |
| `--ngrok` / `--cloudflared` | 自动启动隧道并打印一键配对串 |
| `--read-only` | 硬只读模式（物理禁止写入、删除、改名与命令） |
| `--no-shell` | 禁用 `run_command`（保留文件读写与只读 Git） |
| `--allow-secrets` | 关闭默认敏感文件拦截（不推荐） |
