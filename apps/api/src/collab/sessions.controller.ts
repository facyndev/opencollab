import {
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';

import type { SessionId, WorkspaceId } from '@opencollab/domain';
import { AccessGuard, CurrentUser } from '../auth/access.guard';
import { ZodPipe } from '../auth/dto';
import type { UserRecord } from '../persistence/user.repository';
import {
  createSessionSchema,
  renameSessionSchema,
  type CreateSessionBody,
  type RenameSessionBody,
} from './dto';
import { SessionService } from './session.service';

// Status passthrough for the tri-state create (201/200/409): the existing
// @HttpCode annotation cannot express a dynamic code.
interface Reply {
  status(code: number): unknown;
}

@Controller()
@UseGuards(AccessGuard)
export class SessionsController {
  constructor(@Inject(SessionService) private readonly service: SessionService) {}

  // S4/S7: only the workspace owner creates sessions (member 403; missing
  // workspace or stranger 404). A fresh id answers 201, an id the caller
  // already owns answers its current session as 200, a taken id answers 409.
  @Post('workspaces/:workspaceId/sessions')
  async create(
    @CurrentUser() user: UserRecord,
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodPipe(createSessionSchema)) body: CreateSessionBody,
    @Res({ passthrough: true }) reply: Reply,
  ): Promise<unknown> {
    const result = await this.service.create(user.id, workspaceId as WorkspaceId, body);
    if (result.kind === 'not-found') throw new NotFoundException();
    if (result.kind === 'forbidden') throw new ForbiddenException();
    if (result.kind === 'conflict') throw new ConflictException();
    reply.status(result.kind === 'created' ? 201 : 200);
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

  // S7: rename answers the session view; non-owners answer 403 without
  // learning whether the session exists; unknown sessions 404.
  @Patch('sessions/:id')
  async rename(
    @CurrentUser() user: UserRecord,
    @Param('id') id: string,
    @Body(new ZodPipe(renameSessionSchema)) body: RenameSessionBody,
  ) {
    const result = await this.service.renameSession(user.id, id as SessionId, body.name);
    if (result.kind === 'not-found') throw new NotFoundException();
    if (result.kind === 'forbidden') throw new ForbiddenException();
    return result.view;
  }

  // S7: delete returns 204 with no body and takes the session's terminals
  // with it; non-owners answer 403, unknown sessions 404.
  @Delete('sessions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@CurrentUser() user: UserRecord, @Param('id') id: string) {
    const result = await this.service.removeSession(user.id, id as SessionId);
    if (result.kind === 'not-found') throw new NotFoundException();
    if (result.kind === 'forbidden') throw new ForbiddenException();
  }
}
