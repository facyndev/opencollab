import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Redirect,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { z } from 'zod';

import type { UserRecord } from '../persistence/user.repository';
import { AccessGuard, CurrentUser } from './access.guard';
import { AuthService, toUserView, type AuthResult } from './auth.service';
import {
  callbackQuerySchema,
  desktopTokenSchema,
  loginSchema,
  refreshSchema,
  registerSchema,
  startQuerySchema,
  ZodPipe,
} from './dto';
import { OAuthService } from './oauth.service';

// Modest per-IP limit for the credential-guessing surface (the module default is looser).
const STRICT = { default: { limit: 10, ttl: 60_000 } };

// The slice of the express response this controller needs.
interface Reply {
  setHeader(name: string, value: string): void;
  redirect(status: number, url: string): void;
  status(code: number): { json(body: unknown): void };
}

const agent = (header: string | undefined): string | undefined => header?.slice(0, 200);

/**
 * Web delivery of a finished OAuth login. T6 replaces this (cookie or
 * redirect to the web app); keep every web-specific choice inside it.
 */
function deliverWebLogin(result: AuthResult): AuthResult {
  return result;
}

@Controller('auth')
@UseGuards(ThrottlerGuard)
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(OAuthService) private readonly oauth: OAuthService,
  ) {}

  @Post('register')
  @Throttle(STRICT)
  register(
    @Body(new ZodPipe(registerSchema)) body: z.infer<typeof registerSchema>,
    @Headers('user-agent') ua?: string,
  ) {
    return this.auth.register(body, agent(ua));
  }

  @Post('login')
  @HttpCode(200)
  @Throttle(STRICT)
  login(
    @Body(new ZodPipe(loginSchema)) body: z.infer<typeof loginSchema>,
    @Headers('user-agent') ua?: string,
  ) {
    return this.auth.login(body.identifier, body.password, agent(ua));
  }

  @Post('refresh')
  @HttpCode(200)
  @Throttle(STRICT)
  refresh(
    @Body(new ZodPipe(refreshSchema)) body: z.infer<typeof refreshSchema>,
    @Headers('user-agent') ua?: string,
  ) {
    return this.auth.refresh(body.refreshToken, agent(ua));
  }

  @Post('logout')
  @HttpCode(204)
  async logout(
    @Body(new ZodPipe(refreshSchema)) body: z.infer<typeof refreshSchema>,
  ): Promise<void> {
    await this.auth.logout(body.refreshToken);
  }

  @Get('me')
  @UseGuards(AccessGuard)
  me(@CurrentUser() user: UserRecord) {
    return toUserView(user);
  }

  @Get('oauth/:provider/start')
  @Redirect()
  start(
    @Param('provider') provider: string,
    @Query(new ZodPipe(startQuerySchema)) query: z.infer<typeof startQuerySchema>,
    @Res({ passthrough: true }) res: Reply,
  ) {
    const flow = this.oauth.start(provider, query.client, query.code_challenge);
    res.setHeader('Set-Cookie', flow.setCookie);
    return { url: flow.url };
  }

  @Post('oauth/:provider/link/start')
  @HttpCode(200)
  @UseGuards(AccessGuard)
  linkStart(
    @Param('provider') provider: string,
    @CurrentUser() user: UserRecord,
    @Res({ passthrough: true }) res: Reply,
  ) {
    const flow = this.oauth.startLink(provider, user.id);
    res.setHeader('Set-Cookie', flow.setCookie);
    return { url: flow.url };
  }

  // The response is written by hand: the desktop gets a 302 to its deep link,
  // the web gets JSON. (@Redirect would redirect every outcome.)
  @Get('oauth/:provider/callback')
  async callback(
    @Param('provider') provider: string,
    @Query(new ZodPipe(callbackQuerySchema)) query: z.infer<typeof callbackQuerySchema>,
    @Res() res: Reply,
    @Headers('cookie') cookies?: string,
    @Headers('user-agent') ua?: string,
  ): Promise<void> {
    // One-shot: this flow's binding cookie is cleared whatever the outcome.
    const clear = this.oauth.clearBindingCookieFor(query.state);
    if (clear) res.setHeader('Set-Cookie', clear);
    const outcome = await this.oauth.callback(provider, query, cookies, agent(ua));
    switch (outcome.kind) {
      case 'desktop':
        res.redirect(302, outcome.redirectUrl);
        return;
      case 'linked':
        res.status(200).json({ linked: true, provider: outcome.provider });
        return;
      case 'login':
        res.status(200).json(deliverWebLogin(outcome.result));
        return;
    }
  }

  @Post('desktop/token')
  @HttpCode(200)
  @Throttle(STRICT)
  desktopToken(
    @Body(new ZodPipe(desktopTokenSchema)) body: z.infer<typeof desktopTokenSchema>,
    @Headers('user-agent') ua?: string,
  ) {
    return this.oauth.exchangeDesktopCode(body.code, body.codeVerifier, agent(ua));
  }
}
