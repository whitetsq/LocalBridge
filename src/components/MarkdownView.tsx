import React, { useState } from 'react';
import { Check, Copy } from 'lucide-react';

interface MarkdownViewProps {
  content: string;
}

interface Block {
  type: 'code' | 'heading' | 'list' | 'paragraph';
  lang?: string;
  level?: number;
  lines: string[];
}

function parseMarkdownBlocks(text: string): Block[] {
  const rawLines = text.split(/\r?\n/);
  const blocks: Block[] = [];
  let i = 0;

  while (i < rawLines.length) {
    const line = rawLines[i];

    // Fenced code block
    const fenceMatch = /^```(\w*)/.exec(line.trim());
    if (fenceMatch) {
      const lang = fenceMatch[1] || '';
      const codeLines: string[] = [];
      i++;
      while (i < rawLines.length && !rawLines[i].trim().startsWith('```')) {
        codeLines.push(rawLines[i]);
        i++;
      }
      i++; // skip closing fence
      blocks.push({ type: 'code', lang, lines: codeLines });
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    const headingMatch = /^(#{1,3})\s+(.+)$/.exec(line);
    if (headingMatch) {
      blocks.push({
        type: 'heading',
        level: headingMatch[1].length,
        lines: [headingMatch[2]],
      });
      i++;
      continue;
    }

    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const listLines: string[] = [];
      while (i < rawLines.length && /^\s*([-*]|\d+\.)\s+/.test(rawLines[i])) {
        listLines.push(rawLines[i].replace(/^\s*([-*]|\d+\.)\s+/, ''));
        i++;
      }
      blocks.push({ type: 'list', lines: listLines });
      continue;
    }

    const paraLines: string[] = [];
    while (
      i < rawLines.length &&
      rawLines[i].trim() !== '' &&
      !rawLines[i].trim().startsWith('```') &&
      !/^#{1,3}\s+/.test(rawLines[i]) &&
      !/^\s*([-*]|\d+\.)\s+/.test(rawLines[i])
    ) {
      paraLines.push(rawLines[i]);
      i++;
    }
    blocks.push({ type: 'paragraph', lines: paraLines });
  }

  return blocks;
}

function renderInline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const regex = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith('`')) {
      parts.push(
        <code
          key={match.index}
          className="px-1.5 py-0.5 mx-0.5 rounded bg-slate-100 dark:bg-slate-800/90 text-slate-800 dark:text-slate-200 font-mono text-[12.5px]"
        >
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith('**')) {
      parts.push(
        <strong key={match.index} className="font-semibold text-slate-950 dark:text-white">
          {token.slice(2, -2)}
        </strong>
      );
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts;
}

function CodeBlock({ lang, code }: { lang?: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(code).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="my-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0B0F17] overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-slate-200 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400">
        <span className="font-mono">{lang || 'text'}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
          <span>{copied ? '已复制' : '复制'}</span>
        </button>
      </div>
      <pre className="p-3 overflow-x-auto text-[12.5px] leading-relaxed font-mono text-slate-800 dark:text-slate-200">
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function MarkdownView({ content }: MarkdownViewProps) {
  const blocks = parseMarkdownBlocks(content);

  return (
    <div className="space-y-2.5 text-[14px] leading-relaxed text-slate-800 dark:text-slate-200 break-words">
      {blocks.map((block, idx) => {
        if (block.type === 'code') {
          return <CodeBlock key={idx} lang={block.lang} code={block.lines.join('\n')} />;
        }
        if (block.type === 'heading') {
          const text = block.lines[0];
          if (block.level === 1) {
            return (
              <h3 key={idx} className="text-base font-semibold text-slate-950 dark:text-white pt-1">
                {renderInline(text)}
              </h3>
            );
          }
          if (block.level === 2) {
            return (
              <h4 key={idx} className="text-[15px] font-semibold text-slate-950 dark:text-white pt-1">
                {renderInline(text)}
              </h4>
            );
          }
          return (
            <h5 key={idx} className="text-sm font-semibold text-slate-900 dark:text-slate-100 pt-0.5">
              {renderInline(text)}
            </h5>
          );
        }
        if (block.type === 'list') {
          return (
            <ul key={idx} className="space-y-1 pl-4 list-disc marker:text-slate-400 dark:marker:text-slate-600">
              {block.lines.map((item, itemIdx) => (
                <li key={itemIdx}>{renderInline(item)}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={idx} className="whitespace-pre-wrap">
            {renderInline(block.lines.join('\n'))}
          </p>
        );
      })}
    </div>
  );
}
