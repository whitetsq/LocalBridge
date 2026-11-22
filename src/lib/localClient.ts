export const DEFAULT_SAFE_ALLOWLIST = [
  'git status',
  'git diff',
  'git log',
  'git branch',
  'npm test',
  'npm run test',
  'npm run lint',
  'npm run build',
  'node --test',
  'npx tsc',
  'pnpm test',
  'pnpm lint',
  'pnpm build',
  'pytest',
  'go test',
  'cargo test',
  'cargo check',
];

const UNSAFE_METACHAR_RE = /[;|`$><\n\r]/;
const SINGLE_AMP_RE = /(?:^|[^&])&(?:[^&]|$)/;

function isSingleSegmentAllowlisted(segment: string, allowlist: string[]): boolean {
  const normalized = segment.trim().replace(/\s+/g, ' ');
  if (!normalized) return false;
  return allowlist.some((rawPrefix) => {
    const prefix = rawPrefix.trim().replace(/\s+/g, ' ');
    if (!prefix) return false;
    return normalized === prefix || normalized.startsWith(`${prefix} `);
  });
}

export function isCommandAllowlisted(command: string, allowlist: string[]): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (UNSAFE_METACHAR_RE.test(trimmed) || SINGLE_AMP_RE.test(trimmed)) return false;

  const segments = trimmed.split('&&').map((s) => s.trim());
  if (segments.some((s) => !s)) return false;
  return segments.every((seg) => isSingleSegmentAllowlisted(seg, allowlist));
}

export function suggestAllowlistPrefix(command: string, allowlist: string[] = []): string | undefined {
  const trimmed = command.trim();
  if (!trimmed || UNSAFE_METACHAR_RE.test(trimmed) || SINGLE_AMP_RE.test(trimmed)) return undefined;
  const segments = trimmed.split('&&').map((s) => s.trim()).filter(Boolean);
  const target =
    segments.find((seg) => !isSingleSegmentAllowlisted(seg, allowlist)) || segments[0];
  if (!target) return undefined;
  const parts = target.split(/\s+/);
  if (parts.length >= 3 && (parts[0] === 'npm' || parts[0] === 'pnpm') && parts[1] === 'run') {
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
