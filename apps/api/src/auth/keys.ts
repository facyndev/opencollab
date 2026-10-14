import { createHmac } from 'node:crypto';

// One key per purpose, derived from JWT_SECRET, so a token minted for one
// purpose (access, oauth state, PKCE) can never be accepted for another.
export const deriveKey = (secret: string, purpose: string): string =>
  createHmac('sha256', secret).update(purpose).digest('hex');
