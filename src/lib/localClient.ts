export const DEFAULT_SAFE_ALLOWLIST = [
  'git status',
  'git diff',
  'git log',
  'git branch',
  'npm test',
  'npm run test',
  'npm run lint',
  'npm run build',
  'npx tsc',
  'pnpm test',
  'pnpm lint',
  'pnpm build',
  'pytest',
  'go test',
  'cargo test',
  'cargo check',
];

const SHELL_METACHAR_RE = /[;&|`$><\n\r]/;

export function isCommandAllowlisted(command: string, allowlist: string[]): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (SHELL_METACHAR_RE.test(trimmed)) return false;

  const normalized = trimmed.replace(/\s+/g, ' ');
  return allowlist.some((rawPrefix) => {
    const prefix = rawPrefix.trim().replace(/\s+/g, ' ');
    if (!prefix) return false;
    return normalized === prefix || normalized.startsWith(`${prefix} `);
  });
}

export function suggestAllowlistPrefix(command: string): string | undefined {
  const trimmed = command.trim();
  if (!trimmed || SHELL_METACHAR_RE.test(trimmed)) return undefined;
  const parts = trimmed.split(/\s+/);
  if (parts.length >= 3 && parts[0] === 'npm' && parts[1] === 'run') {
    return `${parts[0]} ${parts[1]} ${parts[2]}`;
  }
  if (parts.length >= 2) {
    return `${parts[0]} ${parts[1]}`;
  }
  return parts[0];
}

/**
 * Parses a one-paste pairing string (`https://xxxx.ngrok-free.app#token=<secret>`
 * or `https://xxxx.ngrok-free.app?token=<secret>`) into `{ tunnelUrl, token }`.
 * Returns `null` if input does not contain an embedded token.
 */
export function parsePairingInput(raw: string): { tunnelUrl: string; token: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    let token = '';
    if (parsed.hash) {
      const hashParams = new URLSearchParams(parsed.hash.replace(/^#/, ''));
      token = hashParams.get('token')?.trim() || '';
    }
    if (!token && parsed.searchParams.has('token')) {
      token = parsed.searchParams.get('token')?.trim() || '';
      parsed.searchParams.delete('token');
    }
    if (!token) return null;
    parsed.hash = '';
    return {
      tunnelUrl: parsed.toString().replace(/\/+$/, ''),
      token,
    };
  } catch {
    return null;
  }
}
