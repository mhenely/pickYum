// The email module reads RESEND_API_KEY at module-load time, so we re-import
// inside jest.isolateModules per test to swap between the "configured" and
// "fail-open" code paths. The Resend client is mocked uniformly — only the
// env switch decides whether the module instantiates it.

const mockSend = jest.fn();
const mockResendCtor = jest.fn().mockImplementation(() => ({
  emails: { send: mockSend },
}));

jest.mock('resend', () => ({ Resend: mockResendCtor }));

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('../../lib/logger', () => ({ logger: mockLogger }));

// Helper that imports the email module under a specific env setup. Re-runs
// the module factory so the `apiKey`/`enabled`/`client` constants reflect
// the current env, not whatever happened to be set when the test file
// was first loaded.
function loadEmail(env: { RESEND_API_KEY?: string; EMAIL_FROM?: string }) {
  let mod!: typeof import('../../lib/email');
  jest.isolateModules(() => {
    const prevKey  = process.env.RESEND_API_KEY;
    const prevFrom = process.env.EMAIL_FROM;
    if (env.RESEND_API_KEY === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = env.RESEND_API_KEY;
    if (env.EMAIL_FROM === undefined) delete process.env.EMAIL_FROM;
    else process.env.EMAIL_FROM = env.EMAIL_FROM;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      mod = require('../../lib/email');
    } finally {
      // Restore so leaking env between tests can't influence other modules.
      if (prevKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prevKey;
      if (prevFrom === undefined) delete process.env.EMAIL_FROM;
      else process.env.EMAIL_FROM = prevFrom;
    }
  });
  return mod;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSend.mockResolvedValue({ data: { id: 'msg-1' }, error: null });
});

describe('sendEmail — fail-open behavior (no RESEND_API_KEY)', () => {
  it('returns true without calling Resend when the API key is unset', async () => {
    const email = loadEmail({});

    const ok = await email.sendEmail({
      to: 'alice@example.com', subject: 's', html: 'h', text: 't',
    });

    // Fail-open contract: this is the documented behavior of the module
    // for local dev / CI environments. If it ever throws or returns false
    // here, registration & forgot-password endpoints will 500 in those
    // environments instead of degrading gracefully.
    expect(ok).toBe(true);
    expect(mockResendCtor).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('logs an informational "skipped" message with the recipient + subject', async () => {
    const email = loadEmail({});

    await email.sendEmail({ to: 'alice@example.com', subject: 'hello', html: '', text: '' });

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'alice@example.com', subject: 'hello', mode: 'noop' }),
      expect.stringContaining('email send skipped'),
    );
  });

  it('treats whitespace-only API keys as unset', async () => {
    const email = loadEmail({ RESEND_API_KEY: '   ' });
    const ok = await email.sendEmail({ to: 'a@b.c', subject: '', html: '', text: '' });

    expect(ok).toBe(true);
    expect(mockResendCtor).not.toHaveBeenCalled();
  });

  it('reports isEmailConfigured() === false', () => {
    const email = loadEmail({});
    expect(email.isEmailConfigured()).toBe(false);
  });
});

describe('sendEmail — configured (RESEND_API_KEY set)', () => {
  it('forwards subject/to/html/text to Resend with the configured from address', async () => {
    const email = loadEmail({ RESEND_API_KEY: 're_test_key', EMAIL_FROM: 'PickYum <hello@example.com>' });

    const ok = await email.sendEmail({
      to: 'alice@example.com',
      subject: 'Verify your email',
      html: '<p>hi</p>',
      text: 'hi',
    });

    expect(ok).toBe(true);
    expect(mockResendCtor).toHaveBeenCalledWith('re_test_key');
    expect(mockSend).toHaveBeenCalledWith({
      from: 'PickYum <hello@example.com>',
      to: 'alice@example.com',
      subject: 'Verify your email',
      html: '<p>hi</p>',
      text: 'hi',
    });
  });

  it('falls back to the default from address when EMAIL_FROM is unset', async () => {
    const email = loadEmail({ RESEND_API_KEY: 're_test_key' });
    await email.sendEmail({ to: 'a@b.c', subject: 's', html: 'h', text: 't' });
    const call = mockSend.mock.calls[0][0];
    // Documented default; if someone changes it, this test catches the
    // silent rebrand of every outgoing email.
    expect(call.from).toBe('PickYum <onboarding@resend.dev>');
  });

  it('returns false and logs when Resend reports an error in the response', async () => {
    mockSend.mockResolvedValue({ data: null, error: { name: 'validation_error', message: 'invalid to' } });
    const email = loadEmail({ RESEND_API_KEY: 're_test_key' });

    const ok = await email.sendEmail({ to: 'bad', subject: 's', html: 'h', text: 't' });

    expect(ok).toBe(false);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.objectContaining({ name: 'validation_error' }) }),
      expect.stringContaining('email send failed'),
    );
  });

  it('returns false and logs when Resend throws', async () => {
    mockSend.mockRejectedValue(new Error('network down'));
    const email = loadEmail({ RESEND_API_KEY: 're_test_key' });

    const ok = await email.sendEmail({ to: 'a@b.c', subject: 's', html: 'h', text: 't' });

    expect(ok).toBe(false);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('email send threw'),
    );
  });

  it('reports isEmailConfigured() === true', () => {
    const email = loadEmail({ RESEND_API_KEY: 're_test_key' });
    expect(email.isEmailConfigured()).toBe(true);
  });
});

describe('templates', () => {
  it('verifyEmailTemplate embeds the verify URL in both html and text bodies', () => {
    const email = loadEmail({});
    const url = 'https://app.example.com/verify-email?token=abc';
    const t = email.verifyEmailTemplate(url);

    expect(t.subject).toMatch(/verify/i);
    expect(t.html).toContain(url);
    expect(t.text).toContain(url);
    // 24-hour TTL is mentioned to the user so they know how long to act.
    expect(t.text).toMatch(/24 hours/i);
  });

  it('passwordResetTemplate embeds the reset URL and the safe-to-ignore note', () => {
    const email = loadEmail({});
    const url = 'https://app.example.com/reset-password?token=abc';
    const t = email.passwordResetTemplate(url);

    expect(t.subject).toMatch(/reset/i);
    expect(t.html).toContain(url);
    expect(t.text).toContain(url);
    // The safe-to-ignore note matters — it tells someone who didn't
    // request the reset that they aren't compromised. Don't let a future
    // tidy-up remove it.
    expect(t.text).toMatch(/safely ignore/i);
    expect(t.text).toMatch(/1 hour/i);
  });
});
