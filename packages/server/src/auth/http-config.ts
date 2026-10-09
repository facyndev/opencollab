import type { INestApplication } from '@nestjs/common';

import type { AuthConfig } from './config';

/**
 * Express-level settings shared by `main.ts` and the test apps. `trust proxy`
 * decides where `req.ip` comes from, and so what the throttler keys on: off
 * means the socket address; behind a reverse proxy it must name the trusted
 * hops, or every client would share the proxy's address.
 */
export function applyHttpConfig(app: INestApplication, config: Pick<AuthConfig, 'trustProxy'>): void {
  app.getHttpAdapter().getInstance().set('trust proxy', config.trustProxy);
}
