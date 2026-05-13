// Instant-runoff (ranked-choice) tally.
//
// Each voter submits an ordered ranking of candidate IDs (their preference,
// best-first). Each round we count first-place votes among still-eligible
// candidates; if any has a majority we stop. Otherwise we eliminate the
// candidate with the fewest first-place votes and ballots that named them
// flow to their next-still-eligible choice.
//
// Edge cases:
// - A ballot that ranks none of the remaining candidates is "exhausted" and
//   doesn't count in that round's total.
// - If the lowest count is shared between candidates and eliminating all of
//   them would leave nobody, the remaining candidates are reported as `tied`
//   and the caller falls back to flip/spin to break it.
// - If a candidate has 0 first-place votes from the start, they're still
//   eliminated first (no special-casing).

export interface IrvRound {
  counts: Record<string, number>;
  eliminated: string | null;
}

export interface IrvResult {
  winner: string | null;
  tied: string[] | null;
  rounds: IrvRound[];
}

export function tallyRanked(
  candidates: string[],
  rankings: Record<string, string[]>,
): IrvResult {
  const rounds: IrvRound[] = [];
  const remaining = new Set(candidates);
  const ballots = Object.values(rankings);

  // No ballots at all — nothing to decide; return a full tie among candidates
  // so the caller falls back to flip/spin (matching simple-vote behavior).
  if (ballots.length === 0) {
    return { winner: null, tied: [...candidates], rounds };
  }

  while (remaining.size > 1) {
    // First-place vote among still-remaining candidates per ballot.
    const counts: Record<string, number> = {};
    for (const id of remaining) counts[id] = 0;
    let active = 0;
    for (const ranking of ballots) {
      const first = ranking.find((id) => remaining.has(id));
      if (first) {
        counts[first]++;
        active++;
      }
    }

    rounds.push({ counts: { ...counts }, eliminated: null });

    // Majority of currently-active ballots → winner.
    const majority = Math.floor(active / 2) + 1;
    for (const [id, count] of Object.entries(counts)) {
      if (count >= majority) {
        return { winner: id, tied: null, rounds };
      }
    }

    // Otherwise eliminate the lowest. Resolve ties by candidate id (alpha) so
    // results are deterministic — flip/spin handles "true" ties at the end.
    const min = Math.min(...Object.values(counts));
    const lowest = Object.entries(counts)
      .filter(([, c]) => c === min)
      .map(([id]) => id)
      .sort();

    // If every remaining candidate is tied at the bottom, we can't eliminate
    // anyone without erasing everyone. Stop and report the tie.
    if (lowest.length === remaining.size) {
      return { winner: null, tied: [...remaining].sort(), rounds };
    }

    const toEliminate = lowest[0];
    remaining.delete(toEliminate);
    rounds[rounds.length - 1].eliminated = toEliminate;
  }

  // One survivor — winner by elimination.
  const winner = [...remaining][0];
  return { winner, tied: null, rounds };
}
