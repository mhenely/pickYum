import { parseVotingStartsAt, parseVoteMethod } from '../../lib/votingFlow';

describe('parseVotingStartsAt', () => {
  it('returns time:null when input is null', () => {
    expect(parseVotingStartsAt(null)).toEqual({ ok: true, time: null });
  });

  it('returns time:null when input is empty string', () => {
    expect(parseVotingStartsAt('')).toEqual({ ok: true, time: null });
  });

  it('returns time:null when input is undefined', () => {
    expect(parseVotingStartsAt(undefined)).toEqual({ ok: true, time: null });
  });

  it('parses a valid future ISO string', () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // +1h
    const result = parseVotingStartsAt(future);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.time).toBeInstanceOf(Date);
      expect(result.time!.toISOString()).toBe(future);
    }
  });

  it('rejects non-string non-null input', () => {
    expect(parseVotingStartsAt(123)).toEqual({ ok: false, error: 'Invalid date format' });
    expect(parseVotingStartsAt({})).toEqual({ ok: false, error: 'Invalid date format' });
  });

  it('rejects unparseable strings', () => {
    expect(parseVotingStartsAt('not-a-date')).toEqual({ ok: false, error: 'Invalid date format' });
  });

  it('rejects past timestamps', () => {
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // -1h
    expect(parseVotingStartsAt(past)).toEqual({
      ok: false,
      error: 'Schedule must be set to a future time',
    });
  });

  it('rejects "now" (must be strictly future)', () => {
    // 1 second in the past — should fail; using exactly Date.now() races,
    // so we test the "<= now" boundary by passing a clearly-past value.
    const justBefore = new Date(Date.now() - 1000).toISOString();
    const result = parseVotingStartsAt(justBefore);
    expect(result.ok).toBe(false);
  });
});

describe('parseVoteMethod', () => {
  it("returns 'SIMPLE' for SIMPLE input", () => {
    expect(parseVoteMethod('SIMPLE')).toBe('SIMPLE');
  });

  it("returns 'RANKED' for RANKED input", () => {
    expect(parseVoteMethod('RANKED')).toBe('RANKED');
  });

  it('returns null for unknown strings', () => {
    expect(parseVoteMethod('simple')).toBeNull();   // case-sensitive
    expect(parseVoteMethod('STAR')).toBeNull();
    expect(parseVoteMethod('')).toBeNull();
  });

  it('returns null for non-string input', () => {
    expect(parseVoteMethod(null)).toBeNull();
    expect(parseVoteMethod(undefined)).toBeNull();
    expect(parseVoteMethod(0)).toBeNull();
    expect(parseVoteMethod(['SIMPLE'])).toBeNull();
  });
});
