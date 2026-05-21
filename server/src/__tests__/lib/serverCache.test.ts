// Note: serverCache reads `redis` from ../../lib/redis. We mock it to
// null in some tests (degraded path) and to a controllable stub in
// others (Redis-configured path). The module reads `redis.status`
// before invoking any client method, so the stub only needs the
// methods we exercise.

describe('serverCache (Redis unavailable)', () => {
  beforeEach(() => jest.resetModules());

  it('falls through to compute() and does not cache when redis is null', async () => {
    jest.doMock('../../lib/redis', () => ({ __esModule: true, default: null }));
    const { cacheRead } = await import('../../lib/serverCache');

    const compute = jest.fn().mockResolvedValue({ value: 1 });
    const result = await cacheRead('foo', 60, compute);
    expect(result).toEqual({ value: 1 });
    expect(compute).toHaveBeenCalledTimes(1);

    // Second call also goes to compute — no cache layer
    await cacheRead('foo', 60, compute);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('cacheClear is a no-op when redis is null (does not throw)', async () => {
    jest.doMock('../../lib/redis', () => ({ __esModule: true, default: null }));
    const { cacheClear } = await import('../../lib/serverCache');
    await expect(cacheClear('foo')).resolves.toBeUndefined();
  });

  it('cacheClearPrefix is a no-op when redis is null', async () => {
    jest.doMock('../../lib/redis', () => ({ __esModule: true, default: null }));
    const { cacheClearPrefix } = await import('../../lib/serverCache');
    await expect(cacheClearPrefix('foo')).resolves.toBeUndefined();
  });
});

// ── Redis-configured path ────────────────────────────────────────

interface FakeRedis {
  status: string;
  get:    jest.Mock;
  setex:  jest.Mock;
  del:    jest.Mock;
  scan:   jest.Mock;
}

function makeRedis(): FakeRedis {
  return {
    status: 'ready',
    get:    jest.fn(),
    setex:  jest.fn().mockResolvedValue('OK'),
    del:    jest.fn().mockResolvedValue(1),
    scan:   jest.fn(),
  };
}

describe('serverCache (Redis ready)', () => {
  let redis: FakeRedis;

  beforeEach(() => {
    jest.resetModules();
    redis = makeRedis();
    jest.doMock('../../lib/redis', () => ({ __esModule: true, default: redis }));
  });

  it('returns the cached value when one is present, without calling compute', async () => {
    redis.get.mockResolvedValue(JSON.stringify({ value: 42 }));
    const { cacheRead } = await import('../../lib/serverCache');

    const compute = jest.fn();
    const result = await cacheRead('foo', 60, compute);
    expect(result).toEqual({ value: 42 });
    expect(compute).not.toHaveBeenCalled();
    // The full key carries the module's namespace prefix.
    expect(redis.get).toHaveBeenCalledWith('cache:foo');
  });

  it('computes + caches on miss', async () => {
    redis.get.mockResolvedValue(null);
    const { cacheRead } = await import('../../lib/serverCache');

    const compute = jest.fn().mockResolvedValue({ value: 'fresh' });
    const result = await cacheRead('foo', 90, compute);
    expect(result).toEqual({ value: 'fresh' });
    expect(compute).toHaveBeenCalledTimes(1);
    // Cache write uses SETEX with the requested TTL
    expect(redis.setex).toHaveBeenCalledWith('cache:foo', 90, JSON.stringify({ value: 'fresh' }));
  });

  it('falls through to compute when Redis read throws', async () => {
    // Network blip on read shouldn't surface to the caller.
    redis.get.mockRejectedValue(new Error('network'));
    const { cacheRead } = await import('../../lib/serverCache');
    const compute = jest.fn().mockResolvedValue({ value: 'recovered' });
    const result = await cacheRead('foo', 60, compute);
    expect(result).toEqual({ value: 'recovered' });
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('returns the computed value when cache write fails', async () => {
    redis.get.mockResolvedValue(null);
    redis.setex.mockRejectedValue(new Error('disk full'));
    const { cacheRead } = await import('../../lib/serverCache');
    const compute = jest.fn().mockResolvedValue({ value: 1 });
    // The cache write happens after compute returns — failure logs at debug, no throw
    await expect(cacheRead('foo', 60, compute)).resolves.toEqual({ value: 1 });
  });

  it('propagates compute() errors (cache must not swallow real failures)', async () => {
    redis.get.mockResolvedValue(null);
    const { cacheRead } = await import('../../lib/serverCache');
    const compute = jest.fn().mockRejectedValue(new Error('DB down'));
    await expect(cacheRead('foo', 60, compute)).rejects.toThrow('DB down');
  });

  it('cacheClear DELs the prefixed key', async () => {
    const { cacheClear } = await import('../../lib/serverCache');
    await cacheClear('foo:42');
    expect(redis.del).toHaveBeenCalledWith('cache:foo:42');
  });

  it('cacheClearPrefix iterates SCAN cursor + DELs matching keys', async () => {
    // First SCAN returns two keys + cursor='5'; second returns one key + cursor='0' (done)
    redis.scan
      .mockResolvedValueOnce(['5', ['cache:groups-list:1', 'cache:groups-list:2']])
      .mockResolvedValueOnce(['0', ['cache:groups-list:3']]);
    const { cacheClearPrefix } = await import('../../lib/serverCache');
    await cacheClearPrefix('groups-list');
    expect(redis.scan).toHaveBeenCalledTimes(2);
    expect(redis.scan).toHaveBeenNthCalledWith(1, '0', 'MATCH', 'cache:groups-list*', 'COUNT', 100);
    expect(redis.del).toHaveBeenCalledTimes(2);
    expect(redis.del).toHaveBeenNthCalledWith(1, 'cache:groups-list:1', 'cache:groups-list:2');
    expect(redis.del).toHaveBeenNthCalledWith(2, 'cache:groups-list:3');
  });

  it('cacheClearPrefix completes without DEL when SCAN returns no matches', async () => {
    redis.scan.mockResolvedValueOnce(['0', []]);
    const { cacheClearPrefix } = await import('../../lib/serverCache');
    await cacheClearPrefix('nothing');
    expect(redis.del).not.toHaveBeenCalled();
  });
});

describe('cacheKeyForUser', () => {
  it('produces the standard per-user shape with optional suffix', async () => {
    jest.resetModules();
    jest.doMock('../../lib/redis', () => ({ __esModule: true, default: null }));
    const { cacheKeyForUser } = await import('../../lib/serverCache');

    expect(cacheKeyForUser('insights', 42)).toBe('insights:42');
    expect(cacheKeyForUser('insights', 42, 'week')).toBe('insights:42:week');
  });
});
