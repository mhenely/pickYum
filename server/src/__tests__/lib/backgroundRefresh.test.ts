import { DeepMockProxy } from 'jest-mock-extended';
import { PrismaClient } from '@prisma/client';

jest.mock('../../lib/prisma');
jest.mock('../../lib/flags', () => ({
  // The bg-refresh module reads `flags.backgroundRefresh` at runtime,
  // not at import time. Mock it as an object reference so individual
  // tests can flip the boolean between cases without re-importing.
  flags: { backgroundRefresh: true, newDetailModal: false, insightsOptOutVisible: true, strictApiSchemaValidation: true },
}));

import prisma from '../../lib/prisma';
import { flags } from '../../lib/flags';
import { __testOnly, registerBackgroundRefresher } from '../../lib/backgroundRefresh';

const mockPrisma = prisma as unknown as DeepMockProxy<PrismaClient>;

describe('backgroundRefresh.runOnce', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Make sure each test starts with the flag in a known state.
    flags.backgroundRefresh = true;
    process.env.GOOGLE_PLACES_API_KEY = 'test-key';
  });

  it('no-ops when the feature flag is off', async () => {
    flags.backgroundRefresh = false;
    const refresher = jest.fn();
    registerBackgroundRefresher(refresher);

    await __testOnly.runOnce();

    expect(refresher).not.toHaveBeenCalled();
    expect(mockPrisma.restaurant.findMany).not.toHaveBeenCalled();
  });

  it('no-ops when GOOGLE_PLACES_API_KEY is unset', async () => {
    delete process.env.GOOGLE_PLACES_API_KEY;
    const refresher = jest.fn();
    registerBackgroundRefresher(refresher);

    await __testOnly.runOnce();
    expect(refresher).not.toHaveBeenCalled();
  });

  it('calls the registered refresher for each stale row, capped at MAX_PER_RUN', async () => {
    const refresher = jest.fn().mockResolvedValue({ id: 1 });
    registerBackgroundRefresher(refresher);

    // Three stale rows — well under the 50 cap.
    (mockPrisma.restaurant.findMany as jest.Mock).mockResolvedValue([
      { id: 1, googlePlaceId: 'gp-1' },
      { id: 2, googlePlaceId: 'gp-2' },
      { id: 3, googlePlaceId: 'gp-3' },
    ]);

    await __testOnly.runOnce();

    expect(refresher).toHaveBeenCalledTimes(3);
    // The findMany query must scope to Google-sourced rows (googlePlaceId
    // not null) and order oldest-stale first. Verifying the WHERE shape
    // here catches regressions where someone might accidentally widen
    // the query and refresh user-typed custom rows.
    const whereArg = (mockPrisma.restaurant.findMany as jest.Mock).mock.calls[0][0].where;
    expect(whereArg.googlePlaceId).toEqual({ not: null });
    const orderByArg = (mockPrisma.restaurant.findMany as jest.Mock).mock.calls[0][0].orderBy;
    expect(orderByArg).toEqual({ googleDataUpdatedAt: 'asc' });
  });

  it('keeps running through one refresher failure (does not abort the batch)', async () => {
    const refresher = jest.fn<Promise<unknown>, [unknown, unknown, unknown]>()
      .mockResolvedValueOnce({ id: 1 })
      .mockRejectedValueOnce(new Error('Google 500'))
      .mockResolvedValueOnce({ id: 3 });
    registerBackgroundRefresher(refresher);

    (mockPrisma.restaurant.findMany as jest.Mock).mockResolvedValue([
      { id: 1, googlePlaceId: 'gp-1' },
      { id: 2, googlePlaceId: 'gp-2' },
      { id: 3, googlePlaceId: 'gp-3' },
    ]);

    await __testOnly.runOnce();

    // All three attempted; the middle one threw but the loop continued.
    // This is the "best effort" contract — one bad row doesn't tank
    // the rest of the batch.
    expect(refresher).toHaveBeenCalledTimes(3);
  });

  it('returns early when there are no stale rows', async () => {
    const refresher = jest.fn();
    registerBackgroundRefresher(refresher);

    (mockPrisma.restaurant.findMany as jest.Mock).mockResolvedValue([]);

    await __testOnly.runOnce();
    expect(refresher).not.toHaveBeenCalled();
  });
});
