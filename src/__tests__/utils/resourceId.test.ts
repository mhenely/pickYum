import { describe, it, expect } from 'vitest';
import { isDbId, isLocalId, parseResourceId, mintLocalId } from '../../utils/resourceId';

describe('isDbId', () => {
  it('accepts positive integers (numeric and string-encoded)', () => {
    expect(isDbId(1)).toBe(true);
    expect(isDbId(42)).toBe(true);
    expect(isDbId('42')).toBe(true);
    expect(isDbId('999999')).toBe(true);
  });

  it('rejects guest local-* stubs', () => {
    expect(isDbId('local-abc')).toBe(false);
    expect(isDbId('local-1700000000-xyz')).toBe(false);
  });

  it('rejects legacy custom-* prefix', () => {
    // Used in older code paths for client-side restaurant rows.
    expect(isDbId('custom-7')).toBe(false);
    expect(isDbId('custom-1234567890')).toBe(false);
  });

  it('rejects null / undefined / zero / negative', () => {
    expect(isDbId(null)).toBe(false);
    expect(isDbId(undefined)).toBe(false);
    expect(isDbId(0)).toBe(false);
    expect(isDbId('0')).toBe(false);
    expect(isDbId(-1)).toBe(false);
    expect(isDbId('-5')).toBe(false);
  });

  it('rejects non-numeric strings', () => {
    expect(isDbId('abc')).toBe(false);
    expect(isDbId('')).toBe(false);
    expect(isDbId('NaN')).toBe(false);
  });
});

describe('isLocalId', () => {
  it('accepts only strings that start with "local-"', () => {
    expect(isLocalId('local-abc')).toBe(true);
    expect(isLocalId('local-1700000000-xyz')).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isLocalId(42)).toBe(false);
    expect(isLocalId('42')).toBe(false);
    expect(isLocalId('custom-7')).toBe(false);
    expect(isLocalId(null)).toBe(false);
    expect(isLocalId(undefined)).toBe(false);
    expect(isLocalId('')).toBe(false);
  });
});

describe('parseResourceId', () => {
  it('returns kind=db for server-side ids', () => {
    expect(parseResourceId(42)).toEqual({ kind: 'db', value: '42' });
    expect(parseResourceId('42')).toEqual({ kind: 'db', value: '42' });
  });
  it('returns kind=local for guest stubs', () => {
    expect(parseResourceId('local-abc')).toEqual({ kind: 'local', value: 'local-abc' });
  });
  it('returns kind=unknown for null/undefined/custom-prefix/junk', () => {
    expect(parseResourceId(null).kind).toBe('unknown');
    expect(parseResourceId(undefined).kind).toBe('unknown');
    expect(parseResourceId('custom-7').kind).toBe('unknown');
    expect(parseResourceId('abc').kind).toBe('unknown');
  });
});

describe('mintLocalId', () => {
  it('produces ids that start with "local-" and are recognized by isLocalId', () => {
    const id = mintLocalId();
    expect(isLocalId(id)).toBe(true);
    expect(isDbId(id)).toBe(false);
  });

  it('returns unique ids when called in quick succession', () => {
    const ids = new Set(Array.from({ length: 100 }, () => mintLocalId()));
    // 100 unique results, even when minted within a single millisecond
    // — the random suffix is the tiebreaker.
    expect(ids.size).toBe(100);
  });

  it('honors an optional prefix segment for debuggability', () => {
    const id = mintLocalId('review');
    expect(id.startsWith('local-review-')).toBe(true);
    expect(isLocalId(id)).toBe(true);
  });
});
