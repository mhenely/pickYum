// Unit tests for the additional password-strength gate. The base
// validatePassword in routes/auth.ts handles length + letter/digit; this
// module catches the shapes that base check can't (common-blocklist,
// identity reuse, sequential/repeated patterns). Tests assert each
// branch independently AND verify that a structurally normal password
// passes — without that sanity check it's too easy to write rules that
// accidentally reject everything.

import { checkPasswordStrength } from '../../lib/passwordStrength';

describe('checkPasswordStrength — accepts strong passwords', () => {
  it('returns null for a password that clears every rule', () => {
    expect(checkPasswordStrength('Wint3rB0rough!47')).toBeNull();
  });

  it('returns null when no identity context is supplied', () => {
    // Defaults branch — opts={} skips the identity check entirely.
    expect(checkPasswordStrength('correcthorsebatterystaple9')).toBeNull();
  });

  it('returns null for a password containing only short identity tokens (<3 chars)', () => {
    // 2-char username should not trigger the identity check — the rule's
    // floor is 3 chars so initials don't ban a real word like "alpine".
    expect(checkPasswordStrength('alpineSlope42', { username: 'al' })).toBeNull();
  });
});

describe('checkPasswordStrength — common-password blocklist', () => {
  it('rejects an exact match from the blocklist', () => {
    expect(checkPasswordStrength('password123')).toMatch(/too common/i);
  });

  it('is case-insensitive (matches Password123 against password123)', () => {
    // Blocklist is lowercased on init; checker lowercases input before
    // lookup. Without that, "Password123" would slip past.
    expect(checkPasswordStrength('Password123')).toMatch(/too common/i);
  });

  it('rejects "letmein123" (common-substring + sequence — blocklist wins first)', () => {
    // The blocklist check runs before the pattern check, so the error
    // message should be the "too common" one even though "123" would
    // also trigger the sequence rule.
    expect(checkPasswordStrength('letmein123')).toMatch(/too common/i);
  });
});

describe('checkPasswordStrength — identity reuse', () => {
  it('rejects a password containing the email local-part', () => {
    // "alice2024" contains the local-part of alice@example.com — exactly
    // the kind of credential a targeted attack would try first.
    const err = checkPasswordStrength('alice2024X!', { email: 'alice@example.com' });
    expect(err).toMatch(/email or username/i);
  });

  it('rejects a password containing the username', () => {
    expect(checkPasswordStrength('MyAlpineRun!', { username: 'alpine' })).toMatch(/email or username/i);
  });

  it('is case-insensitive on identity comparison', () => {
    expect(checkPasswordStrength('XaliceX99!', { username: 'ALICE' })).toMatch(/email or username/i);
  });

  it('does not reject when only a 2-char fragment of identity appears (below the 3-char floor)', () => {
    // "al" matches username start but identity rule needs the token to be
    // ≥3 chars before it's considered. Otherwise initials & common
    // letter pairs would block too many legit passwords.
    expect(checkPasswordStrength('alpineSlope42', { username: 'al' })).toBeNull();
  });
});

describe('checkPasswordStrength — obvious patterns', () => {
  it('rejects 4+ consecutive ascending characters ("1234" anywhere)', () => {
    expect(checkPasswordStrength('myCool1234word')).toMatch(/sequences/i);
  });

  it('rejects 4+ consecutive descending characters ("4321" anywhere)', () => {
    expect(checkPasswordStrength('start4321finish')).toMatch(/sequences/i);
  });

  it('rejects 4+ consecutive letters ("abcd")', () => {
    expect(checkPasswordStrength('XYZabcdQQ1')).toMatch(/sequences/i);
  });

  it('rejects 4+ identical characters in a row ("aaaa")', () => {
    expect(checkPasswordStrength('greataaaaPass1')).toMatch(/sequences/i);
  });

  it('accepts 3 identical characters (just under the threshold)', () => {
    // Rule fires at 4+ repeats; "aaa" alone is fine. Without this case
    // the test suite couldn't distinguish "off by one" regressions.
    expect(checkPasswordStrength('MyGreataaa9Yes')).toBeNull();
  });

  it('accepts a 3-character sequence ("123" alone is too short)', () => {
    // Sequence rule fires at length 4+; "123" plus more chars is fine.
    expect(checkPasswordStrength('Yes123ToGoXY')).toBeNull();
  });
});

describe('checkPasswordStrength — rule precedence', () => {
  it('returns the common-password error first when both blocklist and pattern would fire', () => {
    // "12345678" is in the blocklist AND has sequential digits. The
    // common-password message is more actionable ("pick something less
    // guessable"), so it should win.
    expect(checkPasswordStrength('12345678')).toMatch(/too common/i);
  });

  it('returns the identity error before the pattern error when both apply', () => {
    // "alice1234" contains the identity token AND a 4-char ascending
    // sequence. Identity is checked before patterns in the implementation,
    // so the identity message wins.
    const err = checkPasswordStrength('alice1234', { email: 'alice@example.com' });
    expect(err).toMatch(/email or username/i);
  });
});
