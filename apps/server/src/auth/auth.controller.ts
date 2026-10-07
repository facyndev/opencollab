import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Post,
  Query,
  Redirect,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { z } from 'zod';

import type { UserRecord } from '../persistence/user.repository';
import { AccessGuard, CurrentUser } from './access.guard';
import { AuthService, toUserView, type AuthResult } from './auth.service';
import { AUTH_CONFIG, type AuthConfig } from './config';
import {
  callbackQuerySchema,
  desktopCodeSchema,
  desktopTokenSchema,
  loginSchema,
  refreshSchema,
  registerSchema,
  startQuerySchema,
  ZodPipe,
} from './dto';
import { OAuthService } from './oauth.service';
import {
  CsrfGuard,
  clearRefreshCookie,
  isSecureBase,
  refreshCookie,
  setRefreshCookie,
} from './web-session';

// Modest per-IP limit for the credential-guessing surface (the module default is looser).
const STRICT = { default: { limit: 10, ttl: 60_000 } };

// The slice of the express response this controller needs.
interface Reply {
  setHeader(name: string, value: string): void;
  append(name: string, value: string): void;
  redirect(status: number, url: string): void;
  status(code: number): { json(body: unknown): void };
}

const agent = (header: string | undefined): string | undefined => header?.slice(0, 200);

/** What a web client gets in the body: the access token only (the refresh token is a cookie). */
function webBody({ refreshToken: _refreshToken, ...rest }: AuthResult) {
  return rest;
}

@Controller('auth')
@UseGuards(ThrottlerGuard)
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(OAuthService) private readonly oauth: OAuthService,
    @Inject(AUTH_CONFIG) config: AuthConfig,
  ) {
    this.secureCookies = isSecureBase(config.publicBaseUrl);
  }

  private readonly secureCookies: boolean;

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

  // Web session routes. The refresh token lives in an httpOnly cookie and the
  // body only carries the access token. Every one needs the CSRF header. CORS is
  // off on purpose: the web reaches these same-origin through a proxy.

  @Post('web/register')
  @UseGuards(CsrfGuard)
  @Throttle(STRICT)
  async webRegister(
    @Body(new ZodPipe(registerSchema)) body: z.infer<typeof registerSchema>,
    @Res({ passthrough: true }) res: Reply,
    @Headers('user-agent') ua?: string,
  ) {
    return this.webSession(res, await this.auth.register(body, agent(ua)));
  }

  @Post('web/login')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @Throttle(STRICT)
  async webLogin(
    @Body(new ZodPipe(loginSchema)) body: z.infer<typeof loginSchema>,
    @Res({ passthrough: true }) res: Reply,
    @Headers('user-agent') ua?: string,
  ) {
    return this.webSession(res, await this.auth.login(body.identifier, body.password, agent(ua)));
  }

  @Post('web/refresh')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @Throttle(STRICT)
  async webRefresh(
    @Res({ passthrough: true }) res: Reply,
    @Headers('cookie') cookies?: string,
    @Headers('user-agent') ua?: string,
  ) {
    const presented = refreshCookie(cookies);
    try {
      if (!presented) throw new UnauthorizedException('Invalid refresh token');
      // Same rotation, reuse detection and family revocation as the JSON route,
      // except a token rotated seconds ago (another tab) only gets an access token.
      const outcome = await this.auth.refreshWeb(presented, agent(ua));
      if (outcome.kind === 'grace') return outcome.access;
      const { refreshToken, ...rest } = outcome.tokens;
      res.setHeader('Set-Cookie', setRefreshCookie(refreshToken, this.secureCookies));
      return rest;
    } catch (error) {
      // A dead cookie is useless: drop it so the browser stops sending it.
      if (error instanceof HttpException) res.setHeader('Set-Cookie', clearRefreshCookie(this.secureCookies));
      throw error;
    }
  }

  @Post('web/logout')
  @HttpCode(204)
  @UseGuards(CsrfGuard)
  async webLogout(
    @Res({ passthrough: true }) res: Reply,
    @Headers('cookie') cookies?: string,
  ): Promise<void> {
    const presented = refreshCookie(cookies);
    if (presented) await this.auth.logout(presented);
    res.setHeader('Set-Cookie', clearRefreshCookie(this.secureCookies));
  }

  private webSession(res: Reply, result: AuthResult) {
    res.setHeader('Set-Cookie', setRefreshCookie(result.refreshToken, this.secureCookies));
    return webBody(result);
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

  // The response is written by hand: the desktop gets a 302 to its deep link and
  // the web a 302 to the web app (never tokens in the URL). (@Redirect would
  // redirect every outcome.) Flows whose state does not verify answer plain HTTP errors.
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
    const web = this.oauth.webTarget(query.state);
    let outcome;
    try {
      outcome = await this.oauth.callback(provider, query, cookies, agent(ua));
    } catch (error) {
      if (web && error instanceof HttpException) {
        res.redirect(302, web.error(error));
        return;
      }
      throw error;
    }
    switch (outcome.kind) {
      case 'desktop':
        res.redirect(302, outcome.redirectUrl);
        return;
      case 'linked':
        res.redirect(302, web?.linked(outcome.provider) ?? '/');
        return;
      case 'login':
        res.append('Set-Cookie', setRefreshCookie(outcome.result.refreshToken, this.secureCookies));
        res.redirect(302, web?.complete ?? '/');
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

  // The web session (cookie + CSRF header, never a bearer access token: a stolen
  // access token must not be able to mint a new session) asks for a one-shot code
  // to hand to the desktop; the desktop then trades it at `desktop/token` exactly
  // as in the OAuth flow. The cookie is only read: it is neither rotated nor cleared.
  @Post('web/desktop-code')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @Throttle(STRICT)
  async desktopCode(
    @Body(new ZodPipe(desktopCodeSchema)) body: z.infer<typeof desktopCodeSchema>,
    @Headers('cookie') cookies?: string,
  ) {
    const presented = refreshCookie(cookies);
    const userId = presented ? await this.auth.sessionUser(presented) : undefined;
    if (!userId) throw new UnauthorizedException('Invalid session');
    return { redirectUrl: await this.oauth.issueDesktopCode(userId, body.code_challenge) };
  }
}
