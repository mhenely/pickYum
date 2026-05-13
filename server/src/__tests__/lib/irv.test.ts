import { tallyRanked } from '../../lib/irv';

describe('tallyRanked (instant-runoff)', () => {
  it('declares a first-round majority winner without elimination', () => {
    const result = tallyRanked(['A', 'B', 'C'], {
      alice: ['A', 'B', 'C'],
      bob:   ['A', 'C', 'B'],
      carol: ['B', 'A', 'C'],
    });
    expect(result.winner).toBe('A');
    expect(result.tied).toBeNull();
    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0].counts).toEqual({ A: 2, B: 1, C: 0 });
    expect(result.rounds[0].eliminated).toBeNull();
  });

  it('runs runoff rounds when no candidate has majority in round 1', () => {
    // Four voters, three candidates. A=2, B=1, C=1 first-choice → no majority
    // (need 3 of 4). Eliminate lowest tied (B by alpha sort). B's voter prefers
    // C next → round 2 becomes A=2, C=2 → still no majority among 4, but only
    // 2 candidates remain so we eliminate again. Wait — actually with 2 left
    // and both at 2/4, lowest-alpha eliminated is A, C wins. Let me re-check.
    //
    // Actually with 2 remaining and a tie, the algorithm reports a tie because
    // eliminating both leaves no candidate. So this scenario tests the tied
    // fallback.
    const result = tallyRanked(['A', 'B', 'C'], {
      v1: ['A', 'C', 'B'],
      v2: ['A', 'B', 'C'],
      v3: ['B', 'C', 'A'],
      v4: ['C', 'A', 'B'],
    });
    // Round 1: A=2, B=1, C=1. No majority (need 3). Eliminate B (lowest, alpha
    // wins tie). Round 2 transfers v3's B-first ballot → C. Final: A=2, C=2.
    // Two-way tie at the bottom across all remaining → reported tied.
    expect(result.winner).toBeNull();
    expect(result.tied).toEqual(['A', 'C']);
    expect(result.rounds[0].counts).toEqual({ A: 2, B: 1, C: 1 });
    expect(result.rounds[0].eliminated).toBe('B');
    expect(result.rounds[1].counts).toEqual({ A: 2, C: 2 });
  });

  it('correctly transfers eliminated ballots to next preference', () => {
    // 5 voters. Round 1: A=2, B=2, C=1 — no majority (need 3).
    // Eliminate C, whose voter ranked B 2nd → Round 2: A=2, B=3 → B wins.
    const result = tallyRanked(['A', 'B', 'C'], {
      v1: ['A', 'C', 'B'],
      v2: ['A', 'B', 'C'],
      v3: ['B', 'A', 'C'],
      v4: ['B', 'C', 'A'],
      v5: ['C', 'B', 'A'],
    });
    expect(result.winner).toBe('B');
    expect(result.rounds).toHaveLength(2);
    expect(result.rounds[0].eliminated).toBe('C');
    expect(result.rounds[1].counts).toEqual({ A: 2, B: 3 });
  });

  it('handles partial (incomplete) ballots — exhausted ballots stop counting', () => {
    // 4 voters. v3 only ranks B. Round 1: A=2, B=1, C=1.
    // Eliminate B (alpha-tied with C, B wins sort). v3's ballot is exhausted now.
    // Round 2 among A=2, C=1, with 3 active ballots, majority = 2 → A wins.
    const result = tallyRanked(['A', 'B', 'C'], {
      v1: ['A'],
      v2: ['A', 'C'],
      v3: ['B'],
      v4: ['C', 'A'],
    });
    expect(result.winner).toBe('A');
    expect(result.rounds[0].counts).toEqual({ A: 2, B: 1, C: 1 });
    expect(result.rounds[0].eliminated).toBe('B');
  });

  it('returns full tie when there are no ballots', () => {
    const result = tallyRanked(['A', 'B'], {});
    expect(result.winner).toBeNull();
    expect(result.tied).toEqual(['A', 'B']);
  });

  it('handles a single-ballot two-candidate race deterministically', () => {
    const result = tallyRanked(['A', 'B'], { alice: ['B', 'A'] });
    expect(result.winner).toBe('B');
    expect(result.rounds[0].counts).toEqual({ A: 0, B: 1 });
  });
});
