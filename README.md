# LocalBridge

**本地仓库 MCP 桥接与 AI 编程代理控制台** — 通过 Chrome 浏览器安全直连本机目录，让 AI 直接读取源码、审查 Git Diff、提出精确修改审批并执行受控终端命令，无需将电脑暴露到公网。

## 核心特性

- **零公网暴露的浏览器直连架构**：前端运行在 Chrome / Edge 中，直接连接本机 `127.0.0.1` 上的代理服务（内置 Chrome Private Network Access 预检响应头），避免必须开启内网穿透的安全隐患。
- **双接入模式**：
  1. **LocalBridge 本机代理（推荐）**：单文件、零第三方依赖的 Node.js (v20+) 脚本 `local-bridge.mjs`，支持完整文件读写、Git Diff、终端命令执行与进程中止。
  2. **Chrome 本地目录直连**：基于浏览器原生 File System Access API，零脚本一键授权本机目录，支持真实文件读取、全文检索与 Diff 写回（不含终端命令）。
- **随时切换的三级安全策略**：
  - **逐条审批**：只读工具自动执行，文件修改与终端命令在执行前弹出带行级 Diff 预览的审批卡片。
  - **安全白名单**：可自定义安全验证命令前缀（自动拦截管道与链式注入符），支持一键将命令加入白名单。
  - **只读模式**：完全禁用文件写入与命令执行，适用于纯代码审查与架构分析。
- **CLI 交互式权限向导**：支持在终端运行 `node local-bridge.mjs setup` 交互选择工作区目录、权限级别（只读 / 读写禁命令 / 完整权限）与监听端口。
- **兼容标准 MCP 协议**：`local-bridge.mjs` 同时暴露标准 MCP JSON-RPC 2.0 端点（`POST /mcp` 及 `POST /mcp/<token>`），配合内网穿透隧道即可供外部 MCP 客户端（如 ChatGPT 开发者模式、Cursor 等）复用。

## 本地开发与部署

### 环境要求

- Node.js `v20+`
- 一个有效的 `GEMINI_API_KEY`

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

复制 `.env.example` 为 `.env`，并填入你的 Gemini API Key：

```bash
cp .env.example .env
```

```env
GEMINI_API_KEY="your_gemini_api_key"
```

### 3. 启动应用

开发模式（Express + Vite）：

```bash
npm run dev
```

生产构建与启动：

```bash
npm run build
NODE_ENV=production npm start
```

访问 `http://localhost:3000` 即可打开 LocalBridge 控制台。

## 使用本机桥接脚本 (`local-bridge.mjs`)

1. 打开 LocalBridge 控制台，进入 **本机脚本与 MCP** 页面下载 `local-bridge.mjs`。
2. 在你的目标代码仓库根目录运行交互式配置向导：

```bash
# macOS / Linux
cd /path/to/your-project
node ~/Downloads/local-bridge.mjs setup

# Windows (CMD / PowerShell)
cd C:\path\to\your-project
node %USERPROFILE%\Downloads\local-bridge.mjs setup
```

3. 也可以通过命令行参数直接启动：

```bash
# 直接以当前目录启动
node local-bridge.mjs

# 只读模式（禁止写文件与执行命令）
node local-bridge.mjs --read-only

# 禁用 Shell 命令执行（仅允许读写文件与 git diff）
node local-bridge.mjs --no-shell --port 4829
```

4. 复制终端打印的本地地址与随机安全 Token，粘贴到控制台完成连接。

## 安全机制说明

- 本机代理默认严格绑定 `127.0.0.1`，不对外网接口开放。
- 所有工具接口均强制校验高熵随机 `X-Bridge-Token`（采用常量时间比对 `timingSafeEqual`）。
- 文件访问通过 `path.resolve` 与 `fs.realpath` 双重校验，防止 `../` 路径穿越及软链接逃逸出授权根目录。
- 终端命令默认注入 `CI=true`、强制超时限制与输出字节上限，并支持在控制台随时中止运行中的进程。

## 作为外部 MCP Server 使用（可选）

如果希望将同一个本机仓库暴露给支持远程 MCP 的外部客户端（如 ChatGPT 开发者模式），可使用 Cloudflare Tunnel 转发本地端口：

```bash
cloudflared tunnel --url http://127.0.0.1:4829
```

随后在外部客户端中将 MCP Server URL 配置为：

```text
https://<your-tunnel-domain>/mcp/<your-bridge-token>
```
