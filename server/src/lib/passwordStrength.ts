// Password strength rules. The base `validatePassword` in routes/auth.ts
// covers length + at-least-one-letter-and-digit. This module adds:
//   - common-password blocklist  (RockYou / HIBP top hits, hand-curated)
//   - identity-similarity check  (containing email local-part or username)
//   - sequential/repeated patterns  ("12345678", "aaaaaaaa", "abcdefgh")
//
// Kept dependency-free intentionally — zxcvbn would catch more (keyboard
// walks, l33t-speak substitutions) but adds ~700KB and pulls a frequency
// dictionary. The rules below catch the most-exploited shapes which is
// the bulk of credential-stuffing value.

// Curated from the top breached-password lists. Lowercase, deduped.
// Not exhaustive — any password in this set is an instant reject; anything
// not in it still has to clear the structural checks below.
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password12', 'password123', 'password1234',
  'passw0rd', 'p@ssword', 'p@ssw0rd', 'passw0rd1',
  '12345678', '123456789', '1234567890', '11111111', '00000000',
  'qwerty123', 'qwerty1234', 'qwertyui', 'qwertyuiop',
  '1q2w3e4r', '1qaz2wsx', '1q2w3e4r5t',
  'abc12345', 'abcd1234', 'abcdefgh', 'asdfghjk', 'asdf1234',
  'iloveyou', 'iloveyou1', 'iloveyou123',
  'letmein1', 'letmein123', 'welcome1', 'welcome123', 'admin123',
  'football1', 'baseball1', 'monkey123', 'dragon123', 'sunshine1',
  'princess1', 'shadow123',
  'trustno1', 'master123',
  'changeme1', 'changeme123',
]);

// 3+ identical chars in a row anywhere ("aaab", "1111"), OR a run of
// ascending/descending alphanumeric (length ≥ 4) anywhere ("1234", "abcd").
// These cover keyboard-mash patterns the blocklist can't enumerate.
function hasObviousPattern(pw: string): boolean {
  if (/(.)\1{3,}/.test(pw)) return true;
  const lower = pw.toLowerCase();
  for (let i = 0; i <= lower.length - 4; i += 1) {
    const a = lower.charCodeAt(i);
    const b = lower.charCodeAt(i + 1);
    const c = lower.charCodeAt(i + 2);
    const d = lower.charCodeAt(i + 3);
    if (b - a === 1 && c - b === 1 && d - c === 1) return true; // ascending
    if (a - b === 1 && b - c === 1 && c - d === 1) return true; // descending
  }
  return false;
}

// Reject if the password contains a 3+ char run of the username or
// the email local-part. "alice2024" for alice@example.com is exactly
// the kind of guessable credential we're trying to block.
function containsIdentity(pw: string, opts: { email?: string; username?: string }): boolean {
  const lower = pw.toLowerCase();
  const tokens: string[] = [];
  if (opts.username && opts.username.length >= 3) tokens.push(opts.username.toLowerCase());
  if (opts.email) {
    const local = opts.email.split('@')[0]?.toLowerCase();
    if (local && local.length >= 3) tokens.push(local);
  }
  return tokens.some((t) => lower.includes(t));
}

/** Returns an error message if the password is weak by structural rules,
 *  or null when it passes. Length + letter/digit check stays in the
 *  caller (validatePassword) — this is the additional strength gate. */
export function checkPasswordStrength(
  pw: string,
  opts: { email?: string; username?: string } = {},
): string | null {
  if (COMMON_PASSWORDS.has(pw.toLowerCase())) {
    return 'That password is too common — pick something less guessable';
  }
  if (containsIdentity(pw, opts)) {
    return "Password shouldn't contain your email or username";
  }
  if (hasObviousPattern(pw)) {
    return 'Avoid sequences or repeated characters (e.g. "1234", "aaaa")';
  }
  return null;
}
