import {
  createParamDecorator,
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';

import type { UserRecord } from '../persistence/user.repository';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';

interface AuthedRequest {
  headers: Record<string, string | string[] | undefined>;
  user?: UserRecord;
}

/** Requires `Authorization: Bearer <access token>` for a user that still exists. */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers['authorization'];
    const token = typeof header === 'string' ? /^Bearer (\S+)$/.exec(header)?.[1] : undefined;
    const userId = token ? this.sessions.verifyAccess(token) : undefined;
    const user = userId ? await this.auth.findUser(userId) : undefined;
    if (!user) throw new UnauthorizedException();
    req.user = user;
    return true;
  }
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): UserRecord =>
    ctx.switchToHttp().getRequest<AuthedRequest>().user as UserRecord,
);
