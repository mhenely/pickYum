import {
  RestaurantIdSchema,
  EmailSchema,
  PasswordSchema,
  NameSchema,
  UsernameSchema,
  RatingSchema,
  ReviewContentSchema,
} from '../../lib/schemas';

describe('RestaurantIdSchema (also covers IdSchema family)', () => {
  it('coerces numeric strings', () => {
    expect(RestaurantIdSchema.parse('42')).toBe(42);
  });

  it('accepts numbers directly', () => {
    expect(RestaurantIdSchema.parse(7)).toBe(7);
  });

  it('rejects zero and negative numbers', () => {
    expect(() => RestaurantIdSchema.parse('0')).toThrow();
    expect(() => RestaurantIdSchema.parse('-1')).toThrow();
  });

  it('rejects non-integers', () => {
    expect(() => RestaurantIdSchema.parse('1.5')).toThrow();
  });

  it('rejects non-numeric input', () => {
    expect(() => RestaurantIdSchema.parse('abc')).toThrow();
  });
});

describe('EmailSchema', () => {
  it('accepts valid emails', () => {
    expect(EmailSchema.parse('alice@example.com')).toBe('alice@example.com');
  });

  it('lowercases + trims', () => {
    expect(EmailSchema.parse('  ALICE@Example.COM  ')).toBe('alice@example.com');
  });

  it('rejects malformed emails', () => {
    expect(() => EmailSchema.parse('not-an-email')).toThrow();
    expect(() => EmailSchema.parse('@example.com')).toThrow();
  });

  it('rejects emails longer than 254 chars (RFC 5321 cap)', () => {
    const huge = 'a'.repeat(245) + '@b.com';  // 245 + 6 = 251 chars — OK
    expect(EmailSchema.parse(huge).length).toBeLessThanOrEqual(254);
    const tooLong = 'a'.repeat(250) + '@b.com'; // 256 chars — too long
    expect(() => EmailSchema.parse(tooLong)).toThrow();
  });
});

describe('PasswordSchema', () => {
  it('accepts passwords meeting all three rules', () => {
    expect(PasswordSchema.parse('Abcd1234')).toBe('Abcd1234');
    expect(PasswordSchema.parse('p4ssw0rd')).toBe('p4ssw0rd');
  });

  it('rejects passwords below 8 chars', () => {
    expect(() => PasswordSchema.parse('Abc1')).toThrow(/at least 8 characters/);
  });

  it('rejects passwords with no letter', () => {
    expect(() => PasswordSchema.parse('12345678')).toThrow(/at least one letter/);
  });

  it('rejects passwords with no digit', () => {
    expect(() => PasswordSchema.parse('abcdefgh')).toThrow(/at least one number/);
  });

  it('matches the existing validatePassword rules on edge cases', () => {
    // These mirror the regex in routes/auth.ts:validatePassword:
    //   /[A-Za-z]/ + /\d/
    expect(() => PasswordSchema.parse('!@#$%^&*')).toThrow();      // symbols only
    expect(() => PasswordSchema.parse('letter1!')).not.toThrow();  // has letter + digit
  });
});

describe('NameSchema', () => {
  it('accepts normal names', () => {
    expect(NameSchema.parse('Trip to Maine')).toBe('Trip to Maine');
  });

  it('trims whitespace', () => {
    expect(NameSchema.parse('  Foo  ')).toBe('Foo');
  });

  it('rejects empty / whitespace-only input', () => {
    expect(() => NameSchema.parse('   ')).toThrow();
    expect(() => NameSchema.parse('')).toThrow();
  });

  it('rejects names longer than 80 chars', () => {
    expect(() => NameSchema.parse('x'.repeat(81))).toThrow();
    expect(NameSchema.parse('x'.repeat(80))).toHaveLength(80);
  });
});

describe('UsernameSchema', () => {
  it('accepts alphanumeric usernames', () => {
    expect(UsernameSchema.parse('alice')).toBe('alice');
    expect(UsernameSchema.parse('user_123')).toBe('user_123');
    expect(UsernameSchema.parse('a-b-c')).toBe('a-b-c');
  });

  it('rejects usernames with disallowed characters', () => {
    expect(() => UsernameSchema.parse('alice@example')).toThrow();
    expect(() => UsernameSchema.parse('alice space')).toThrow();
    expect(() => UsernameSchema.parse('alice!')).toThrow();
  });

  it('rejects usernames longer than 32 chars', () => {
    expect(() => UsernameSchema.parse('x'.repeat(33))).toThrow();
  });

  it('rejects empty / whitespace-only', () => {
    expect(() => UsernameSchema.parse('')).toThrow();
    expect(() => UsernameSchema.parse('   ')).toThrow();
  });
});

describe('RatingSchema', () => {
  it('accepts ratings in 0.5 increments from 0 to 5', () => {
    for (const v of [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5]) {
      expect(RatingSchema.parse(v)).toBe(v);
    }
  });

  it('rejects out-of-range', () => {
    expect(() => RatingSchema.parse(-0.5)).toThrow();
    expect(() => RatingSchema.parse(5.5)).toThrow();
  });

  it('rejects non-0.5 increments', () => {
    expect(() => RatingSchema.parse(3.3)).toThrow();
    expect(() => RatingSchema.parse(4.7)).toThrow();
  });
});

describe('ReviewContentSchema', () => {
  it('accepts empty content (rating-only submissions)', () => {
    expect(ReviewContentSchema.parse('')).toBe('');
  });

  it('accepts content up to 4000 chars', () => {
    expect(ReviewContentSchema.parse('x'.repeat(4000)).length).toBe(4000);
  });

  it('rejects content longer than 4000 chars', () => {
    expect(() => ReviewContentSchema.parse('x'.repeat(4001))).toThrow();
  });
});
