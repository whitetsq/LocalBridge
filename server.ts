import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import type { Content, FunctionDeclaration } from '@google/genai';
import { getLocalBridgeScript } from './src/lib/bridgeScriptTemplate.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

function getAiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      '服务器未配置 GEMINI_API_KEY，请在 AI Studio 的 Settings > Secrets 面板检查密钥配置。'
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function buildToolDeclarations(allowWrite: boolean, allowShell: boolean): FunctionDeclaration[] {
  const readTools: FunctionDeclaration[] = [
    {
      name: 'inspect_workspace',
      description:
        '查看当前本地仓库的整体概况：项目名、技术栈、package.json 脚本、Git 分支与未提交变更数，以及顶层目录树。首次了解项目时优先调用。',
      parameters: {
        type: Type.OBJECT,
        properties: {
          detail: {
            type: Type.STRING,
            description: '可选说明，通常传 "overview"',
          },
        },
      },
    },
    {
      name: 'list_directory',
      description: '列出指定相对目录下的文件和子目录（自动跳过 .git 和 node_modules）。',
      parameters: {
        type: Type.OBJECT,
        properties: {
          path: {
            type: Type.STRING,
            description: '相对工作区根目录的路径，例如 "." 或 "src/components"',
          },
        },
      },
    },
    {
      name: 'read_file',
      description:
        '读取工作区内的文本文件内容，支持 1-indexed 行号范围（startLine / endLine）。修改文件前必须先读取。',
      parameters: {
        type: Type.OBJECT,
        properties: {
          path: {
            type: Type.STRING,
            description: '相对工作区根目录的文件路径',
          },
          startLine: {
            type: Type.INTEGER,
            description: '起始行号（从 1 开始，可选）',
          },
          endLine: {
            type: Type.INTEGER,
            description: '结束行号（包含该行，可选）',
          },
        },
        required: ['path'],
      },
    },
    {
      name: 'search_files',
      description: '在工作区源码中按关键词或正则表达式全文检索匹配的代码行。',
      parameters: {
        type: Type.OBJECT,
        properties: {
          query: {
            type: Type.STRING,
            description: '搜索关键词或正则表达式',
          },
          dir: {
            type: Type.STRING,
            description: '限定搜索的子目录（默认 "."）',
          },
          maxResults: {
            type: Type.INTEGER,
            description: '最大返回条数（默认 40，上限 100）',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'git_diff',
      description: '查看当前仓库的 git status 和 git diff 改动详情。',
      parameters: {
        type: Type.OBJECT,
        properties: {
          path: {
            type: Type.STRING,
            description: '可选：只查看某个文件或目录的 diff',
          },
          staged: {
            type: Type.BOOLEAN,
            description: '是否查看已暂存（--staged）的改动',
          },
        },
      },
    },
  ];

  const writeTools: FunctionDeclaration[] = [
    {
      name: 'edit_file',
      description:
        '精确替换已有文件中的唯一一段代码（推荐优先使用，避免重写整个大文件）。oldString 必须与文件现有内容完全一致。',
      parameters: {
        type: Type.OBJECT,
        properties: {
          path: {
            type: Type.STRING,
            description: '相对文件路径',
          },
          oldString: {
            type: Type.STRING,
            description: '需要被替换的原始精确文本片段',
          },
          newString: {
            type: Type.STRING,
            description: '替换后的新文本片段',
          },
          replaceAll: {
            type: Type.BOOLEAN,
            description: '是否替换全部匹配项（默认 false）',
          },
        },
        required: ['path', 'oldString', 'newString'],
      },
    },
    {
      name: 'write_file',
      description: '新建文件或完整覆写一个较小的文件（会自动创建缺失的父目录）。',
      parameters: {
        type: Type.OBJECT,
        properties: {
          path: {
            type: Type.STRING,
            description: '相对文件路径',
          },
          content: {
            type: Type.STRING,
            description: '完整文件内容',
          },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'delete_file',
      description: '删除工作区内的单个文件（不可删除目录）。',
      parameters: {
        type: Type.OBJECT,
        properties: {
          path: {
            type: Type.STRING,
            description: '要删除的相对文件路径',
          },
        },
        required: ['path'],
      },
    },
    {
      name: 'create_directory',
      description: '在工作区内创建新文件夹（自动递归创建缺失的父目录）。',
      parameters: {
        type: Type.OBJECT,
        properties: {
          path: {
            type: Type.STRING,
            description: '要新建的相对目录路径，例如 "src/utils" 或 "docs/archive"',
          },
        },
        required: ['path'],
      },
    },
    {
      name: 'move_path',
      description: '在工作区内移动或重命名文件/文件夹（例如整理目录结构、文件归档或重命名）。',
      parameters: {
        type: Type.OBJECT,
        properties: {
          from: {
            type: Type.STRING,
            description: '源相对路径',
          },
          to: {
            type: Type.STRING,
            description: '目标相对路径',
          },
        },
        required: ['from', 'to'],
      },
    },
  ];

  const shellTools: FunctionDeclaration[] = [
    {
      name: 'run_command',
      description:
        '在用户本机工作区执行终端命令（例如 git status, npm test, npm run build, tsc, pytest 等）。禁止运行无限阻塞的 dev server。',
      parameters: {
        type: Type.OBJECT,
        properties: {
          command: {
            type: Type.STRING,
            description: '要执行的完整命令字符串',
          },
          cwd: {
            type: Type.STRING,
            description: '相对工作区根目录的执行目录（默认 "."）',
          },
          timeoutMs: {
            type: Type.INTEGER,
            description: '超时时间（毫秒，默认 30000，上限 120000）',
          },
        },
        required: ['command'],
      },
    },
  ];

  return [
    ...readTools,
    ...(allowWrite ? writeTools : []),
    ...(allowShell ? shellTools : []),
  ];
}

function buildSystemInstruction(context: {
  workspaceName?: string;
  mode?: string;
  policy?: string;
  noShell?: boolean;
}): string {
  const modeDesc =
    context.mode === 'bridge'
      ? '已通过本机 LocalBridge MCP 服务连接用户本地仓库'
      : context.mode === 'browser-fs'
        ? '已通过 Chrome 浏览器 File System Access API 直接挂载用户本地目录（支持读写本地文件，不支持执行本机终端命令）'
        : '尚未连接本地仓库';

  const policyDesc =
    context.policy === 'readonly'
      ? '当前安全策略为【只读禁命令模式】：只能读取和分析代码，不得写入文件或执行命令。'
      : context.policy === 'allowlist'
        ? '当前安全策略为【安全白名单模式】：白名单内的验证命令可自动放行，其余命令和文件修改由用户审批。'
        : '当前安全策略为【逐条审批模式】：只读工具自动执行，文件写入与终端命令在执行前会交由用户逐条审批。';

  return [
    '你是 LocalBridge 的高级本地仓库 AI 编程代理，职责类似于 CodexPro / Claude Code，通过工具直接读取、分析、修改用户的本地代码仓库并执行验证命令。',
    `当前环境状态：${modeDesc}${context.workspaceName ? `（工作区：${context.workspaceName}）` : ''}。`,
    policyDesc,
    context.noShell ? '注意：本机 Bridge 启动了 --no-shell 参数，终端命令已禁用。' : '',
    '工作准则：',
    '1. 严禁凭空猜测文件内容或目录结构。先用 inspect_workspace / list_directory / search_files / read_file 获取真实上下文。',
    '2. 可以单轮并行发起多个只读工具调用（例如同时读取 2-3 个相关文件）以降低延迟。',
    '3. 修改已有文件时优先使用 edit_file 进行精确局部替换，尽量避免整文件覆写；修改前必须先 read_file。',
    '4. 如果用户拒绝了某次文件修改或命令执行，尊重用户的决定，结合用户的反馈调整方案，切勿重复强行发起同一被拒操作。',
    '5. 回复保持简洁、结构化、务实，默认使用中文（除非用户使用其他语言），引用代码时标明精确的相对路径和行号。',
  ]
    .filter(Boolean)
    .join('\n');
}

function resolveThinkingLevel(level?: string): ThinkingLevel {
  if (level === 'LOW') return ThinkingLevel.LOW;
  if (level === 'MEDIUM') return ThinkingLevel.MEDIUM;
  return ThinkingLevel.HIGH;
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
      model: 'gemini-4-hydrogen',
    });
  });

  app.get('/api/bridge-script', (_req, res) => {
    const script = getLocalBridgeScript();
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="local-bridge.mjs"');
    res.send(script);
  });

  app.post('/api/agent/step', async (req, res) => {
    try {
      const {
        contents,
        workspaceContext = {},
        thinkingLevel = 'MEDIUM',
      } = req.body as {
        contents: Content[];
        workspaceContext?: {
          workspaceName?: string;
          mode?: string;
          policy?: string;
          noShell?: boolean;
        };
        thinkingLevel?: string;
      };

      if (!Array.isArray(contents) || contents.length === 0) {
        res.status(400).json({ error: '缺少有效的对话历史 contents' });
        return;
      }

      const ai = getAiClient();
      const connected = workspaceContext.mode === 'bridge' || workspaceContext.mode === 'browser-fs';
      const allowWrite = connected && workspaceContext.policy !== 'readonly';
      const allowShell =
        workspaceContext.mode === 'bridge' &&
        workspaceContext.policy !== 'readonly' &&
        !workspaceContext.noShell;

      const tools = connected
        ? [{ functionDeclarations: buildToolDeclarations(allowWrite, allowShell) }]
        : undefined;

      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents,
        config: {
          systemInstruction: buildSystemInstruction(workspaceContext),
          thinkingConfig: {
            thinkingLevel: resolveThinkingLevel(thinkingLevel),
          },
          ...(tools ? { tools } : {}),
        },
      });

      const modelContent = response.candidates?.[0]?.content ?? null;
      const functionCalls = response.functionCalls ?? [];

      res.json({
        modelContent,
        text: response.text ?? '',
        functionCalls,
        usageMetadata: response.usageMetadata ?? null,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const status =
        typeof (err as { status?: unknown })?.status === 'number'
          ? ((err as { status: number }).status)
          : 500;
      console.error('[LocalBridge /api/agent/step] Error:', message);
      res.status(status >= 400 && status < 600 ? status : 500).json({
        error: message,
      });
    }
  });

  if (IS_PROD) {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('/{*splat}', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR !== 'true',
        watch: process.env.DISABLE_HMR === 'true' ? null : {},
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`LocalBridge server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start LocalBridge server:', err);
  process.exit(1);
});
