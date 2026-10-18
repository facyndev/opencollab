import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';

import type { SessionId, WorkspaceId } from '@opencollab/domain';
import { AccessGuard, CurrentUser } from '../auth/access.guard';
import { ZodPipe } from '../auth/dto';
import type { UserRecord } from '../persistence/user.repository';
import { createSessionSchema, type CreateSessionBody } from './dto';
import { SessionService } from './session.service';

@Controller()
@UseGuards(AccessGuard)
export class SessionsController {
  constructor(@Inject(SessionService) private readonly service: SessionService) {}

  // S4: owner creates; member 403; missing workspace or stranger 404.
  @Post('workspaces/:workspaceId/sessions')
  @HttpCode(201)
  async create(
    @CurrentUser() user: UserRecord,
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodPipe(createSessionSchema)) body: CreateSessionBody,
  ) {
    const result = await this.service.create(user.id, workspaceId as WorkspaceId, body.name);
    if (result.kind === 'not-found') throw new NotFoundException();
    if (result.kind === 'forbidden') throw new ForbiddenException();
    return result.view;
  }

  // S5: owner or member list; missing workspace or stranger 404.
  @Get('workspaces/:workspaceId/sessions')
  async list(@CurrentUser() user: UserRecord, @Param('workspaceId') workspaceId: string) {
    const result = await this.service.list(user.id, workspaceId as WorkspaceId);
    if (result.kind === 'not-found') throw new NotFoundException();
    return result.views;
  }

  // S6: any viewer (owner, member, guest); 403 without view access, 404 unknown.
  @Get('sessions/:id')
  async detail(@CurrentUser() user: UserRecord, @Param('id') id: string) {
    const result = await this.service.detail(id as SessionId, user.id);
    if (result.kind === 'not-found') throw new NotFoundException();
    if (result.kind === 'forbidden') throw new ForbiddenException();
    return result.view;
  }
}
