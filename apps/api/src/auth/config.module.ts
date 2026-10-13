import { Module } from '@nestjs/common';

import { AUTH_CONFIG, loadAuthConfig, type AuthConfig } from './config';

// Throws at startup when JWT_SECRET or DATABASE_URL is missing.
@Module({
  providers: [{ provide: AUTH_CONFIG, useFactory: (): AuthConfig => loadAuthConfig(process.env) }],
  exports: [AUTH_CONFIG],
})
export class AuthConfigModule {}
