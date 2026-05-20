import { DeepMockProxy } from 'jest-mock-extended';
import { PrismaClient } from '@prisma/client';

jest.mock('../../lib/prisma');

import prisma from '../../lib/prisma';
import { loadVisibleRestaurant } from '../../lib/authHelpers';

const mockPrisma = prisma as unknown as DeepMockProxy<PrismaClient>;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('loadVisibleRestaurant', () => {
  it('returns the row when it is public', async () => {
    (mockPrisma.restaurant.findUnique as jest.Mock).mockResolvedValue({
      id: 1, private: false, createdBy: 99,
    });

    const result = await loadVisibleRestaurant(1, 50);
    expect(result).toEqual({ id: 1, private: false, createdBy: 99 });
  });

  it('returns the row when private and the viewer is the creator', async () => {
    (mockPrisma.restaurant.findUnique as jest.Mock).mockResolvedValue({
      id: 1, private: true, createdBy: 50,
    });

    const result = await loadVisibleRestaurant(1, 50);
    expect(result).toEqual({ id: 1, private: true, createdBy: 50 });
  });

  it('returns null when private and the viewer is not the creator', async () => {
    (mockPrisma.restaurant.findUnique as jest.Mock).mockResolvedValue({
      id: 1, private: true, createdBy: 99,
    });

    const result = await loadVisibleRestaurant(1, 50);
    expect(result).toBeNull();
  });

  it('returns null when the row does not exist', async () => {
    (mockPrisma.restaurant.findUnique as jest.Mock).mockResolvedValue(null);

    const result = await loadVisibleRestaurant(999, 50);
    expect(result).toBeNull();
  });

  it('selects only the minimal columns needed for the visibility check', async () => {
    // Existence-hiding property — we don't read more columns than
    // necessary so a future "leak the response" bug can't expose
    // unrelated fields.
    (mockPrisma.restaurant.findUnique as jest.Mock).mockResolvedValue({
      id: 1, private: false, createdBy: null,
    });

    await loadVisibleRestaurant(1, 50);
    expect(mockPrisma.restaurant.findUnique).toHaveBeenCalledWith({
      where: { id: 1 },
      select: { id: true, private: true, createdBy: true },
    });
  });
});
