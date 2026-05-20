import { parseNumericId } from '../../lib/validators';

describe('parseNumericId', () => {
  it('returns the number for valid positive integers', () => {
    expect(parseNumericId('1')).toBe(1);
    expect(parseNumericId('42')).toBe(42);
    expect(parseNumericId('1000000')).toBe(1000000);
  });

  it('returns null for zero', () => {
    expect(parseNumericId('0')).toBeNull();
  });

  it('returns null for negative numbers', () => {
    expect(parseNumericId('-1')).toBeNull();
    expect(parseNumericId('-100')).toBeNull();
  });

  it('returns null for non-integers', () => {
    expect(parseNumericId('1.5')).toBeNull();
    expect(parseNumericId('3.14')).toBeNull();
  });

  it('returns null for non-numeric strings', () => {
    expect(parseNumericId('abc')).toBeNull();
    expect(parseNumericId('')).toBeNull();
    expect(parseNumericId('1a')).toBeNull();
  });

  it('returns null for undefined / missing input', () => {
    expect(parseNumericId(undefined)).toBeNull();
  });

  it('returns null for NaN-producing inputs', () => {
    expect(parseNumericId('NaN')).toBeNull();
    expect(parseNumericId('Infinity')).toBeNull();
  });

  it('matches the historical parseId implementations bit-for-bit', () => {
    // Sanity check against the inline impls being replaced — same
    // truthy/falsy decisions on each edge case.
    const historicalParseId = (raw: string): number | null => {
      const id = Number(raw);
      return Number.isInteger(id) && id > 0 ? id : null;
    };
    for (const input of ['1', '0', '-1', '1.5', 'abc', '', '999999', '0.0']) {
      expect(parseNumericId(input)).toBe(historicalParseId(input));
    }
  });
});
