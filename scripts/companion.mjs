#!/usr/bin/env node
/**
 * LocalBridge Companion CLI v2.0
 *
 * Usage:
 *   node scripts/companion.mjs status
 *   node scripts/companion.mjs call <toolName> '<jsonArgs>'
 *   node scripts/companion.mjs call <toolName> --stdin
 *   node scripts/companion.mjs tree [path] [maxDepth]
 *   node scripts/companion.mjs git <status|diff|staged_diff|log|branches|show> [cwd] [extraJson]
 *   node scripts/companion.mjs find <pattern> [path]
 *   node scripts/companion.mjs read <file[:start-end]> [file2[:start-end] ...]
 */

const BASE_URL = process.env.LOCALBRIDGE_COMPANION_URL || 'http://127.0.0.1:3000';

async function readStdin() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk.toString('utf8');
  return raw;
}

async function callCompanion(tool, args) {
  const res = await fetch(`${BASE_URL}/api/companion/call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool, args }),
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) {
    console.error(JSON.stringify(data, null, 2));
    process.exit(1);
  }
  return data;
}

function formatCompactTree(nodes, indent = '') {
  const lines = [];
  for (const n of nodes || []) {
    if (n.type === 'dir') {
      lines.push(`${indent}${n.name}/`);
      if (Array.isArray(n.children) && n.children.length > 0) {
        lines.push(...formatCompactTree(n.children, indent + '  '));
      }
    } else {
      lines.push(`${indent}${n.name}`);
    }
  }
  return lines;
}

function parseReadSpec(raw) {
  const match = raw.match(/^(.*?):(\d+)-(\d+)$/);
  if (match) {
    return { path: match[1], startLine: Number(match[2]), endLine: Number(match[3]) };
  }
  const single = raw.match(/^(.*?):(\d+)$/);
  if (single) {
    const start = Number(single[2]);
    return { path: single[1], startLine: start, endLine: start + 200 };
  }
  return { path: raw, startLine: 1, endLine: 300 };
}

async function main() {
  const [, , cmd, ...rest] = process.argv;

  if (!cmd || cmd === 'status') {
    const res = await fetch(`${BASE_URL}/api/companion/state`);
    const state = await res.json();
    console.log(
      JSON.stringify(
        {
          connected: state.connected,
          workspace: state.workspace,
          policy: state.policy,
          autoApproveFileWrites: state.autoApproveFileWrites,
          pendingApprovals: (state.pendingApprovals || []).length,
        },
        null,
        2
      )
    );
    return;
  }

  if (cmd === 'tree') {
    const targetPath = rest[0] || '.';
    const maxDepth = Number(rest[1] || 2);
    const data = await callCompanion('inspect_workspace', { path: targetPath, maxDepth });
    const r = data.result || {};
    console.log(`Workspace: ${r.name} (${r.rootPath}) [${data.durationMs}ms]`);
    if (Array.isArray(r.gitRepos) && r.gitRepos.length > 0) {
      console.log(
        'Git Repos: ' +
          r.gitRepos
            .map((g) => `${g.path} (${g.branch || '?'}${g.dirtyCount ? `, ${g.dirtyCount} dirty` : ''})`)
            .join(' | ')
      );
    }
    console.log(formatCompactTree(r.tree).join('\n'));
    return;
  }

  if (cmd === 'git') {
    const action = rest[0] || 'status';
    const cwd = rest[1] || '.';
    const extra = rest[2] ? JSON.parse(rest[2]) : {};
    const data = await callCompanion('git_inspect', { action, cwd, ...extra });
    const r = data.result || {};
    if (r.error) {
      console.error(`git_inspect error (${r.cwd}): ${r.error}`);
      process.exit(1);
    }
    console.log(`[${r.cwd} @ ${r.branch || '?'}] git ${r.action} (${data.durationMs}ms)`);
    console.log(r.output || '(empty)');
    return;
  }

  if (cmd === 'find') {
    const pattern = rest[0] || '';
    const targetPath = rest[1] || '.';
    const data = await callCompanion('find_files', { pattern, path: targetPath });
    const r = data.result || {};
    console.log(`Found ${r.count} files${r.truncated ? ' (truncated)' : ''} [${data.durationMs}ms]`);
    console.log((r.files || []).join('\n'));
    return;
  }

  if (cmd === 'read') {
    if (rest.length === 0) {
      console.error('Usage: node scripts/companion.mjs read <file[:start-end]> [...]');
      process.exit(1);
    }
    const specs = rest.map(parseReadSpec);
    if (specs.length === 1) {
      const data = await callCompanion('read_file', specs[0]);
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    const data = await callCompanion('read_files', { files: specs });
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (cmd === 'call') {
    const toolName = rest[0];
    if (!toolName) {
      console.error('Missing toolName. Usage: node scripts/companion.mjs call <toolName> <jsonArgs|--stdin>');
      process.exit(1);
    }
    let rawArgs = '{}';
    if (rest[1] === '--stdin') {
      rawArgs = (await readStdin()).trim() || '{}';
    } else if (rest[1]) {
      rawArgs = rest[1];
    }
    let parsedArgs;
    try {
      parsedArgs = JSON.parse(rawArgs);
    } catch (err) {
      console.error('Invalid JSON args:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    const data = await callCompanion(toolName, parsedArgs);
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  console.error(`Unknown subcommand: ${cmd}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
