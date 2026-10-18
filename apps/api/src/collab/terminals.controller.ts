import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';

import type { SessionId, TerminalId } from '@opencollab/domain';
import { AccessGuard, CurrentUser } from '../auth/access.guard';
import { ZodPipe } from '../auth/dto';
import type { UserRecord } from '../persistence/user.repository';
import { addTerminalSchema, type AddTerminalBody } from './dto';
import { SessionService } from './session.service';

@Controller()
@UseGuards(AccessGuard)
export class TerminalsController {
  constructor(@Inject(SessionService) private readonly service: SessionService) {}

  // S7: owner only; 403 for anyone else, 404 for an unknown session.
  @Post('sessions/:id/terminals')
  @HttpCode(201)
  async create(
    @CurrentUser() user: UserRecord,
    @Param('id') id: string,
    @Body(new ZodPipe(addTerminalSchema)) body: AddTerminalBody,
  ) {
    const result = await this.service.addTerminal(user.id, id as SessionId, body);
    if (result.kind === 'not-found') throw new NotFoundException();
    if (result.kind === 'forbidden') throw new ForbiddenException();
    return result.view;
  }

  // S8: owner only; 204 on success, 404 for unknown session or terminal,
  // 403 for anyone else (terminal existence stays hidden from non-owners).
  @Delete('sessions/:id/terminals/:terminalId')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: UserRecord,
    @Param('id') id: string,
    @Param('terminalId') terminalId: string,
  ) {
    const result = await this.service.removeTerminal(
      user.id,
      id as SessionId,
      terminalId as TerminalId,
    );
    if (result.kind === 'not-found') throw new NotFoundException();
    if (result.kind === 'forbidden') throw new ForbiddenException();
  }
}
