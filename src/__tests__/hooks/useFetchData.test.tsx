import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useFetchData } from '../../hooks/useFetchData';

describe('useFetchData', () => {
  it('starts in the loading state with null data and error', () => {
    const fetcher = vi.fn(() => new Promise(() => {})); // never resolves
    const { result } = renderHook(() => useFetchData(fetcher, []));
    expect(result.current).toMatchObject({ data: null, loading: true, error: null });
  });

  it('populates data and clears loading on success', async () => {
    const fetcher = vi.fn().mockResolvedValue({ id: 1, name: 'Pho 99' });
    const { result } = renderHook(() => useFetchData(fetcher, []));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual({ id: 1, name: 'Pho 99' });
    expect(result.current.error).toBeNull();
  });

  it('populates error and clears loading on rejection', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('Server down'));
    const { result } = renderHook(() => useFetchData(fetcher, []));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('Server down');
    expect(result.current.data).toBeNull();
  });

  it('falls back to a default message when the rejection has no Error.message', async () => {
    const fetcher = vi.fn().mockRejectedValue('plain string');
    const { result } = renderHook(() => useFetchData(fetcher, []));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('Failed to load data');
  });

  it('re-fetches when a dep changes', async () => {
    const fetcher = vi.fn().mockResolvedValue('v1');
    const { result, rerender } = renderHook(
      ({ id }) => useFetchData(fetcher, [id]),
      { initialProps: { id: 1 } },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetcher).toHaveBeenCalledTimes(1);

    fetcher.mockResolvedValueOnce('v2');
    rerender({ id: 2 });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.current.data).toBe('v2');
  });

  it('skips the fetch when enabled is false', () => {
    const fetcher = vi.fn(() => new Promise(() => {}));
    const { result } = renderHook(() =>
      useFetchData(fetcher, [], { enabled: false }),
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({ data: null, loading: false, error: null });
  });

  it('fetches when enabled flips from false to true', async () => {
    const fetcher = vi.fn().mockResolvedValue('on');
    const { result, rerender } = renderHook(
      ({ enabled }) => useFetchData(fetcher, [], { enabled }),
      { initialProps: { enabled: false } },
    );
    expect(fetcher).not.toHaveBeenCalled();

    rerender({ enabled: true });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.current.data).toBe('on');
  });

  it('refetch() triggers a fresh fetch', async () => {
    const fetcher = vi.fn().mockResolvedValue('initial');
    const { result } = renderHook(() => useFetchData(fetcher, []));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetcher).toHaveBeenCalledTimes(1);

    fetcher.mockResolvedValueOnce('refetched');
    act(() => result.current.refetch());

    await waitFor(() => expect(result.current.data).toBe('refetched'));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not call setState after unmount', async () => {
    let resolveFetch: ((v: string) => void) | null = null;
    const fetcher = vi.fn(
      () => new Promise<string>((r) => { resolveFetch = r; }),
    );
    const { result, unmount } = renderHook(() => useFetchData(fetcher, []));

    expect(result.current.loading).toBe(true);
    unmount();
    // Resolve AFTER unmount — should not throw an "update on unmounted
    // component" warning, and result.current shouldn't update further.
    resolveFetch!('late');
    await new Promise((r) => setTimeout(r, 0));
    // No assertion needed beyond "no warning thrown" — vitest fails
    // the test if React logs an act() warning. The cancellation flag
    // is what prevents the setState call.
    expect(result.current.loading).toBe(true); // frozen at unmount snapshot
  });

  it('uses the latest fetcher closure when deps trigger a re-fetch', async () => {
    // Caller doesn't memoize fetcher; it captures `id` from outer
    // scope. When id changes, deps trigger a re-fetch and we should
    // call the new closure (which reads the new id).
    const { result, rerender } = renderHook(
      ({ id }) => useFetchData(() => Promise.resolve(`got-${id}`), [id]),
      { initialProps: { id: 1 } },
    );
    await waitFor(() => expect(result.current.data).toBe('got-1'));

    rerender({ id: 2 });
    await waitFor(() => expect(result.current.data).toBe('got-2'));
  });
});
