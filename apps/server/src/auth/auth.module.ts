import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';

import { PersistenceModule } from '../persistence/persistence.module';
import { AccessGuard } from './access.guard';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { CLOCK, systemClock } from './clock';
import { AUTH_CONFIG, type AuthConfig } from './config';
import { AuthConfigModule } from './config.module';
import { OAUTH_PROVIDERS, type OAuthProviders } from './oauth-provider';
import { OAuthService } from './oauth.service';
import { PasswordService } from './password.service';
import { GithubProvider, GoogleProvider } from './providers';
import { SessionService } from './session.service';

function buildProviders(config: AuthConfig): OAuthProviders {
  const { github, google } = config.oauth;
  return {
    ...(github ? { github: new GithubProvider(github) } : {}),
    ...(google ? { google: new GoogleProvider(google) } : {}),
  };
}

@Module({
  imports: [
    PersistenceModule,
    AuthConfigModule,
    ThrottlerModule.forRootAsync({
      imports: [AuthConfigModule],
      inject: [AUTH_CONFIG],
      useFactory: (config: AuthConfig) => ({
        throttlers: [{ ttl: 60_000, limit: 60 }],
        skipIf: () => !config.rateLimitEnabled,
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    { provide: CLOCK, useValue: systemClock },
    { provide: OAUTH_PROVIDERS, useFactory: buildProviders, inject: [AUTH_CONFIG] },
    PasswordService,
    SessionService,
    AuthService,
    OAuthService,
    AccessGuard,
  ],
  exports: [SessionService],
})
export class AuthModule {}
