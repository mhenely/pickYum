import { Resend } from 'resend';
import { logger } from './logger';

// The email service is intentionally fail-open: if RESEND_API_KEY is not set
// (e.g. local dev, CI), every send() logs and returns true rather than throwing.
// That way registration/password-reset endpoints don't 500 in environments
// without an email provider configured — they just won't actually deliver.

const apiKey  = process.env.RESEND_API_KEY?.trim();
const fromAddress = process.env.EMAIL_FROM?.trim() || 'PickYum <onboarding@resend.dev>';
const enabled = !!apiKey;
const client  = enabled ? new Resend(apiKey) : null;

export interface SendArgs {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export async function sendEmail(args: SendArgs): Promise<boolean> {
  if (!enabled || !client) {
    logger.info({ to: args.to, subject: args.subject, mode: 'noop' }, 'email send skipped (RESEND_API_KEY not set)');
    return true;
  }
  try {
    const { error } = await client.emails.send({
      from: fromAddress,
      to: args.to,
      subject: args.subject,
      html: args.html,
      text: args.text,
    });
    if (error) {
      logger.error({ err: error, to: args.to, subject: args.subject }, 'email send failed');
      return false;
    }
    return true;
  } catch (err) {
    logger.error({ err, to: args.to, subject: args.subject }, 'email send threw');
    return false;
  }
}

// ── Templates ─────────────────────────────────────────────────
// Plain-Tailwind-free HTML so it survives every email client. Keep markup
// shallow — Outlook hates flexbox.

const APP_NAME = 'PickYum';

function shell(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f5f5f5;margin:0;padding:24px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:32px">
    <tr><td>
      <h1 style="font-size:20px;color:#111;margin:0 0 16px">${escapeHtml(title)}</h1>
      ${bodyHtml}
      <p style="font-size:12px;color:#888;margin-top:32px">— The ${APP_NAME} team</p>
    </td></tr>
  </table>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string),
  );
}

export function verifyEmailTemplate(verifyUrl: string): { subject: string; html: string; text: string } {
  return {
    subject: `Verify your ${APP_NAME} email`,
    text: `Welcome to ${APP_NAME}! Verify your email by visiting:\n${verifyUrl}\n\nThis link expires in 24 hours.`,
    html: shell(
      `Verify your ${APP_NAME} email`,
      `<p style="color:#444;line-height:1.5">Click the button below to confirm your email address. The link expires in 24 hours.</p>
       <p style="margin:24px 0"><a href="${verifyUrl}" style="background:#f97316;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;display:inline-block;font-weight:600">Verify email</a></p>
       <p style="color:#888;font-size:12px;word-break:break-all">Or paste this link into your browser: ${verifyUrl}</p>`,
    ),
  };
}

export function passwordResetTemplate(resetUrl: string): { subject: string; html: string; text: string } {
  return {
    subject: `Reset your ${APP_NAME} password`,
    text: `Someone requested a password reset for your ${APP_NAME} account.\nIf this was you, visit:\n${resetUrl}\n\nThis link expires in 1 hour. If you didn't request this, you can safely ignore this email.`,
    html: shell(
      'Reset your password',
      `<p style="color:#444;line-height:1.5">Someone requested a password reset for your ${APP_NAME} account. The link expires in 1 hour.</p>
       <p style="margin:24px 0"><a href="${resetUrl}" style="background:#f97316;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;display:inline-block;font-weight:600">Reset password</a></p>
       <p style="color:#888;font-size:12px;word-break:break-all">Or paste this link into your browser: ${resetUrl}</p>
       <p style="color:#888;font-size:12px;margin-top:16px">If you didn't request this, you can safely ignore this email — your password won't change.</p>`,
    ),
  };
}

export function isEmailConfigured(): boolean {
  return enabled;
}
