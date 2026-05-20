// Unit tests for the photo-storage helpers. We mock the @supabase
// storage SDK so uploads don't hit the network, then verify:
//   1. SSRF allow-list — rejects CDN URLs whose host isn't a Google
//      domain (defense-in-depth against a compromised upstream).
//   2. HTTPS-only — http:// URLs are rejected.
//   3. Content-type validation — non-image responses are rejected
//      so we can't get tricked into hosting HTML/JS at a .jpg path.
//   4. Happy path — legit Google CDN URLs upload bytes + return the
//      public Supabase URL.
//   5. Disabled-storage path — when SUPABASE env vars are unset,
//      returns null without any work.

const mockUpload = jest.fn();

jest.mock('@supabase/storage-js', () => ({
  StorageClient: jest.fn().mockImplementation(() => ({
    from: jest.fn().mockReturnValue({ upload: mockUpload }),
  })),
}));

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

import {
  mirrorPhotoFromCdnUrl,
  proxyMirroredPublicUrl,
  _resetStorageClientForTests,
} from '../../lib/photoStorage';

const savedEnv = { ...process.env };

beforeEach(() => {
  mockUpload.mockReset();
  mockUpload.mockResolvedValue({ error: null });
  mockFetch.mockReset();
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
  process.env.SUPABASE_STORAGE_BUCKET = 'restaurant-photos';
  _resetStorageClientForTests();
});

afterAll(() => {
  process.env = savedEnv;
});

describe('mirrorPhotoFromCdnUrl — SSRF allow-list', () => {
  it('rejects URLs from hosts not in the Google allow-list', async () => {
    const url = await mirrorPhotoFromCdnUrl({
      googleName: 'places/p1/photos/abc',
      maxWidthPx: 400,
      cdnUrl: 'https://attacker.example.com/payload.jpg',
    });
    expect(url).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('rejects http:// URLs (HTTPS only)', async () => {
    const url = await mirrorPhotoFromCdnUrl({
      googleName: 'places/p1/photos/abc',
      maxWidthPx: 400,
      cdnUrl: 'http://lh3.googleusercontent.com/signed',
    });
    expect(url).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects malformed URLs', async () => {
    const url = await mirrorPhotoFromCdnUrl({
      googleName: 'places/p1/photos/abc',
      maxWidthPx: 400,
      cdnUrl: 'not-a-url',
    });
    expect(url).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('accepts googleusercontent.com hosts', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: (h: string) => (h === 'content-type' ? 'image/jpeg' : null) },
      arrayBuffer: async () => new ArrayBuffer(8),
    });

    const url = await mirrorPhotoFromCdnUrl({
      googleName: 'places/p1/photos/abc',
      maxWidthPx: 400,
      cdnUrl: 'https://lh3.googleusercontent.com/signed-token',
    });
    expect(url).toMatch(/test\.supabase\.co/);
    expect(mockFetch).toHaveBeenCalled();
    expect(mockUpload).toHaveBeenCalled();
  });

  it('accepts ggpht.com hosts', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: (h: string) => (h === 'content-type' ? 'image/jpeg' : null) },
      arrayBuffer: async () => new ArrayBuffer(8),
    });

    const url = await mirrorPhotoFromCdnUrl({
      googleName: 'places/p1/photos/abc',
      maxWidthPx: 400,
      cdnUrl: 'https://lh5.ggpht.com/signed',
    });
    expect(url).not.toBeNull();
  });

  it('accepts gstatic.com hosts', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: (h: string) => (h === 'content-type' ? 'image/jpeg' : null) },
      arrayBuffer: async () => new ArrayBuffer(8),
    });

    const url = await mirrorPhotoFromCdnUrl({
      googleName: 'places/p1/photos/abc',
      maxWidthPx: 400,
      cdnUrl: 'https://maps.gstatic.com/signed',
    });
    expect(url).not.toBeNull();
  });
});

describe('mirrorPhotoFromCdnUrl — content-type validation', () => {
  it('rejects text/html responses', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: (h: string) => (h === 'content-type' ? 'text/html' : null) },
      arrayBuffer: async () => new ArrayBuffer(8),
    });

    const url = await mirrorPhotoFromCdnUrl({
      googleName: 'places/p1/photos/abc',
      maxWidthPx: 400,
      cdnUrl: 'https://lh3.googleusercontent.com/signed',
    });
    expect(url).toBeNull();
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('rejects application/javascript responses', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: (h: string) => (h === 'content-type' ? 'application/javascript' : null) },
      arrayBuffer: async () => new ArrayBuffer(8),
    });

    const url = await mirrorPhotoFromCdnUrl({
      googleName: 'places/p1/photos/abc',
      maxWidthPx: 400,
      cdnUrl: 'https://lh3.googleusercontent.com/signed',
    });
    expect(url).toBeNull();
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('accepts image/png', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: (h: string) => (h === 'content-type' ? 'image/png' : null) },
      arrayBuffer: async () => new ArrayBuffer(8),
    });

    const url = await mirrorPhotoFromCdnUrl({
      googleName: 'places/p1/photos/abc',
      maxWidthPx: 400,
      cdnUrl: 'https://lh3.googleusercontent.com/signed',
    });
    expect(url).not.toBeNull();
    expect(mockUpload).toHaveBeenCalledWith(
      expect.stringMatching(/^proxy-cache\/[a-f0-9]{32}\.jpg$/),
      expect.any(ArrayBuffer),
      expect.objectContaining({ contentType: 'image/png' }),
    );
  });

  it('accepts image/webp', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: (h: string) => (h === 'content-type' ? 'image/webp' : null) },
      arrayBuffer: async () => new ArrayBuffer(8),
    });

    const url = await mirrorPhotoFromCdnUrl({
      googleName: 'places/p1/photos/abc',
      maxWidthPx: 400,
      cdnUrl: 'https://lh3.googleusercontent.com/signed',
    });
    expect(url).not.toBeNull();
  });
});

describe('mirrorPhotoFromCdnUrl — failure paths', () => {
  it('returns null when the CDN fetch is not ok', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });

    const url = await mirrorPhotoFromCdnUrl({
      googleName: 'places/p1/photos/abc',
      maxWidthPx: 400,
      cdnUrl: 'https://lh3.googleusercontent.com/signed',
    });
    expect(url).toBeNull();
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('returns null when the CDN fetch throws', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNRESET'));

    const url = await mirrorPhotoFromCdnUrl({
      googleName: 'places/p1/photos/abc',
      maxWidthPx: 400,
      cdnUrl: 'https://lh3.googleusercontent.com/signed',
    });
    expect(url).toBeNull();
  });

  it('returns null when Supabase upload returns an error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => 'image/jpeg' },
      arrayBuffer: async () => new ArrayBuffer(8),
    });
    mockUpload.mockResolvedValueOnce({ error: { message: 'quota exceeded' } });

    const url = await mirrorPhotoFromCdnUrl({
      googleName: 'places/p1/photos/abc',
      maxWidthPx: 400,
      cdnUrl: 'https://lh3.googleusercontent.com/signed',
    });
    expect(url).toBeNull();
  });

  it('returns null when SUPABASE_URL is not configured', async () => {
    delete process.env.SUPABASE_URL;
    _resetStorageClientForTests();

    const url = await mirrorPhotoFromCdnUrl({
      googleName: 'places/p1/photos/abc',
      maxWidthPx: 400,
      cdnUrl: 'https://lh3.googleusercontent.com/signed',
    });
    expect(url).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockUpload).not.toHaveBeenCalled();
  });
});

describe('mirrorPhotoFromCdnUrl — path determinism', () => {
  it('uses the same path for the same (googleName, maxWidthPx) pair', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      headers: { get: () => 'image/jpeg' },
      arrayBuffer: async () => new ArrayBuffer(8),
    });

    await mirrorPhotoFromCdnUrl({
      googleName: 'places/p1/photos/abc',
      maxWidthPx: 400,
      cdnUrl: 'https://lh3.googleusercontent.com/a',
    });
    await mirrorPhotoFromCdnUrl({
      googleName: 'places/p1/photos/abc',
      maxWidthPx: 400,
      cdnUrl: 'https://lh3.googleusercontent.com/b', // different signed URL
    });

    const path1 = mockUpload.mock.calls[0][0];
    const path2 = mockUpload.mock.calls[1][0];
    expect(path1).toBe(path2);
  });

  it('uses different paths for different widths', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      headers: { get: () => 'image/jpeg' },
      arrayBuffer: async () => new ArrayBuffer(8),
    });

    await mirrorPhotoFromCdnUrl({
      googleName: 'places/p1/photos/abc',
      maxWidthPx: 200,
      cdnUrl: 'https://lh3.googleusercontent.com/a',
    });
    await mirrorPhotoFromCdnUrl({
      googleName: 'places/p1/photos/abc',
      maxWidthPx: 800,
      cdnUrl: 'https://lh3.googleusercontent.com/a',
    });

    const path1 = mockUpload.mock.calls[0][0];
    const path2 = mockUpload.mock.calls[1][0];
    expect(path1).not.toBe(path2);
  });
});

describe('proxyMirroredPublicUrl', () => {
  it('returns null when SUPABASE_URL is not configured', () => {
    delete process.env.SUPABASE_URL;
    expect(proxyMirroredPublicUrl('places/p1/photos/abc', 400)).toBeNull();
  });

  it('returns a stable URL for the same input', () => {
    const url1 = proxyMirroredPublicUrl('places/p1/photos/abc', 400);
    const url2 = proxyMirroredPublicUrl('places/p1/photos/abc', 400);
    expect(url1).toBe(url2);
    expect(url1).toMatch(/test\.supabase\.co.*proxy-cache\/[a-f0-9]{32}\.jpg/);
  });

  it('returns different URLs for different widths', () => {
    const url200 = proxyMirroredPublicUrl('places/p1/photos/abc', 200);
    const url400 = proxyMirroredPublicUrl('places/p1/photos/abc', 400);
    expect(url200).not.toBe(url400);
  });
});
