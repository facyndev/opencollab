import {
  Body,
  ConflictException,
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

import type { SessionId, UserId, WorkspaceId } from '@opencollab/domain';
import { AccessGuard, CurrentUser } from '../auth/access.guard';
import { ZodPipe } from '../auth/dto';
import type { UserRecord } from '../persistence/user.repository';
import { inviteSchema, type InviteBody } from './dto';
import { InvitationsService } from './invitations.service';

@Controller()
@UseGuards(AccessGuard)
export class InvitationsController {
  constructor(@Inject(InvitationsService) private readonly service: InvitationsService) {}

  // S9: owner invites a workspace member; 201 with the invitation view.
  @Post('workspaces/:id/invitations')
  @HttpCode(201)
  async inviteToWorkspace(
    @CurrentUser() user: UserRecord,
    @Param('id') id: string,
    @Body(new ZodPipe(inviteSchema)) body: InviteBody,
  ) {
    const result = await this.service.inviteToWorkspace(
      user.id,
      id as WorkspaceId,
      body.inviteeId as UserId,
    );
    if (result.kind === 'not-found') throw new NotFoundException();
    if (result.kind === 'forbidden') throw new ForbiddenException();
    if (result.kind === 'conflict') throw new ConflictException();
    return result.view;
  }

  // S10: owner invites a session guest; 201 with the invitation view.
  @Post('sessions/:id/invitations')
  @HttpCode(201)
  async inviteToSession(
    @CurrentUser() user: UserRecord,
    @Param('id') id: string,
    @Body(new ZodPipe(inviteSchema)) body: InviteBody,
  ) {
    const result = await this.service.inviteToSession(
      user.id,
      id as SessionId,
      body.inviteeId as UserId,
    );
    if (result.kind === 'not-found') throw new NotFoundException();
    if (result.kind === 'forbidden') throw new ForbiddenException();
    if (result.kind === 'conflict') throw new ConflictException();
    return result.view;
  }

  // S11: the caller's pending, non-expired invitations.
  @Get('invitations')
  async list(@CurrentUser() user: UserRecord) {
    return this.service.list(user.id);
  }

  // S12: only the invitee may accept; 204 with no body.
  @Post('invitations/:id/accept')
  @HttpCode(204)
  async accept(@CurrentUser() user: UserRecord, @Param('id') id: string) {
    const result = await this.service.accept(user.id, id);
    if (result.kind === 'not-found') throw new NotFoundException();
    if (result.kind === 'forbidden') throw new ForbiddenException();
    if (result.kind === 'conflict') throw new ConflictException();
  }

  // S13: only the invitee may decline; 204 with no body.
  @Post('invitations/:id/decline')
  @HttpCode(204)
  async decline(@CurrentUser() user: UserRecord, @Param('id') id: string) {
    const result = await this.service.decline(user.id, id);
    if (result.kind === 'not-found') throw new NotFoundException();
    if (result.kind === 'forbidden') throw new ForbiddenException();
    if (result.kind === 'conflict') throw new ConflictException();
  }
}
