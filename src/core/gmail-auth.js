import { createHash, createHmac, hkdfSync, randomUUID, timingSafeEqual } from 'node:crypto';
import { requireValue } from '../integrations/gmail/composio.js';

export const GMAIL_DEMO_USER = 'operator-demo';
const cookieName = '__Host-errand-gmail';
const tokenPattern = /^[A-Za-z0-9_-]{32,128}$/;
const digest = value => createHash('sha256').update(value).digest();
export function createGmailAuth({ token, now = Date.now }) {
  requireValue(typeof token === 'string' && tokenPattern.test(token), 'setup_required', 503);
  const key = Buffer.from(hkdfSync('sha256', token, '', 'errand-gmail-operator-cookie-v1', 32));
  const sign = payload => createHmac('sha256', key).update(payload).digest('base64url');
  return Object.freeze({
    login(authorization) {
      const supplied = authorization?.match(/^Bearer ([A-Za-z0-9_-]{32,128})$/)?.[1];
      requireValue(supplied && timingSafeEqual(digest(supplied), digest(token)), 'operator_rejected', 403);
      const payload = Buffer.from(JSON.stringify({ userId: GMAIL_DEMO_USER, sessionId: randomUUID(), expiresAt: now() + 30 * 60 * 1000 })).toString('base64url');
      return `${cookieName}=${payload}.${sign(payload)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=1800`;
    },
    authenticate(request) {
      const header = request.headers instanceof Headers ? request.headers.get('cookie') : request.headers?.cookie;
      if (typeof header !== 'string' || header.length > 8192) return null;
      const values = header.split(';').map(v => v.trim()).filter(v => v.startsWith(`${cookieName}=`));
      if (values.length !== 1) return null;
      const parts = values[0].slice(cookieName.length + 1).split('.');
      if (parts.length !== 2 || !parts.every(v => /^[A-Za-z0-9_-]+$/.test(v))) return null;
      if (!timingSafeEqual(digest(parts[1]), digest(sign(parts[0])))) return null;
      try {
        const value = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
        if (value.userId !== GMAIL_DEMO_USER || !/^[a-f0-9-]{36}$/.test(value.sessionId) || !Number.isSafeInteger(value.expiresAt)
          || value.expiresAt <= now() || value.expiresAt > now() + 30 * 60 * 1000) return null;
        return { userId: value.userId, sessionId: value.sessionId };
      } catch { return null; }
    },
    logout: () => `${cookieName}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
  });
}
