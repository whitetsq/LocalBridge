export interface DiffLine {
  type: 'context' | 'add' | 'remove' | 'meta';
  oldLine?: number;
  newLine?: number;
  text: string;
}

/**
 * Computes a compact unified-style line diff between `before` and `after` using LCS.
 * Falls back gracefully for very large files by showing a focused change window.
 */
export function computeLineDiff(before: string, after: string, contextLines = 3): DiffLine[] {
  const a = before === '' ? [] : before.split(/\r?\n/);
  const b = after === '' ? [] : after.split(/\r?\n/);

  // Trim shared prefix and suffix to keep DP small even on large files
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }

  const aMid = a.slice(prefix, a.length - suffix);
  const bMid = b.slice(prefix, b.length - suffix);

  const raw: DiffLine[] = [];

  for (let i = 0; i < prefix; i++) {
    raw.push({ type: 'context', oldLine: i + 1, newLine: i + 1, text: a[i] });
  }

  if (aMid.length * bMid.length <= 250_000) {
    const m = aMid.length;
    const n = bMid.length;
    const dp: Uint32Array[] = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));

    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        if (aMid[i] === bMid[j]) {
          dp[i][j] = dp[i + 1][j + 1] + 1;
        } else {
          dp[i][j] = dp[i + 1][j] >= dp[i][j + 1] ? dp[i + 1][j] : dp[i][j + 1];
        }
      }
    }

    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (aMid[i] === bMid[j]) {
        raw.push({
          type: 'context',
          oldLine: prefix + i + 1,
          newLine: prefix + j + 1,
          text: aMid[i],
        });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        raw.push({ type: 'remove', oldLine: prefix + i + 1, text: aMid[i] });
        i++;
      } else {
        raw.push({ type: 'add', newLine: prefix + j + 1, text: bMid[j] });
        j++;
      }
    }
    while (i < m) {
      raw.push({ type: 'remove', oldLine: prefix + i + 1, text: aMid[i] });
      i++;
    }
    while (j < n) {
      raw.push({ type: 'add', newLine: prefix + j + 1, text: bMid[j] });
      j++;
    }
  } else {
    for (let i = 0; i < aMid.length; i++) {
      raw.push({ type: 'remove', oldLine: prefix + i + 1, text: aMid[i] });
    }
    for (let j = 0; j < bMid.length; j++) {
      raw.push({ type: 'add', newLine: prefix + j + 1, text: bMid[j] });
    }
  }

  for (let s = 0; s < suffix; s++) {
    const oldIdx = a.length - suffix + s;
    const newIdx = b.length - suffix + s;
    raw.push({
      type: 'context',
      oldLine: oldIdx + 1,
      newLine: newIdx + 1,
      text: a[oldIdx],
    });
  }

  // Filter down to changed lines + surrounding context hunks
  const keep = new Uint8Array(raw.length);
  for (let idx = 0; idx < raw.length; idx++) {
    if (raw[idx].type !== 'context') {
      const start = Math.max(0, idx - contextLines);
      const end = Math.min(raw.length - 1, idx + contextLines);
      for (let k = start; k <= end; k++) keep[k] = 1;
    }
  }

  const collapsed: DiffLine[] = [];
  let skipping = false;
  for (let idx = 0; idx < raw.length; idx++) {
    if (keep[idx]) {
      skipping = false;
      collapsed.push(raw[idx]);
    } else if (!skipping) {
      skipping = true;
      collapsed.push({ type: 'meta', text: '...' });
    }
  }

  return collapsed;
}

export function parseRawGitDiff(diffText: string): DiffLine[] {
  if (!diffText.trim()) return [];
  const lines = diffText.split(/\r?\n/);
  const result: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    if (
      line.startsWith('diff --git') ||
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ')
    ) {
      result.push({ type: 'meta', text: line });
    } else if (line.startsWith('@@')) {
      const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (match) {
        oldLine = Number(match[1]);
        newLine = Number(match[2]);
      }
      result.push({ type: 'meta', text: line });
    } else if (line.startsWith('+')) {
      result.push({ type: 'add', newLine: newLine++, text: line.slice(1) });
    } else if (line.startsWith('-')) {
      result.push({ type: 'remove', oldLine: oldLine++, text: line.slice(1) });
    } else {
      result.push({
        type: 'context',
        oldLine: oldLine ? oldLine++ : undefined,
        newLine: newLine ? newLine++ : undefined,
        text: line.startsWith(' ') ? line.slice(1) : line,
      });
    }
  }

  return result;
}
