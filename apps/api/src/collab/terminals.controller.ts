import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Res,
  UseGuards,
} from '@nestjs/common';

import type { SessionId, TerminalId } from '@opencollab/domain';
import { AccessGuard, CurrentUser } from '../auth/access.guard';
import { ZodPipe } from '../auth/dto';
import type { UserRecord } from '../persistence/user.repository';
import {
  addTerminalSchema,
  reorderTerminalsSchema,
  updateTerminalSchema,
  type AddTerminalBody,
  type ReorderTerminalsBody,
  type UpdateTerminalBody,
} from './dto';
import { SessionService } from './session.service';

// Status passthrough for the tri-state create (201/200/409): the existing
// @HttpCode annotation cannot express a dynamic code.
interface Reply {
  status(code: number): unknown;
}

@Controller()
@UseGuards(AccessGuard)
export class TerminalsController {
  constructor(@Inject(SessionService) private readonly service: SessionService) {}

  // S7: owner only; 403 for anyone else, 404 for an unknown session. A fresh
  // id answers 201, an id the caller already owns answers its current
  // terminal as 200 (idempotent), and a taken id answers 409.
  @Post('sessions/:id/terminals')
  async create(
    @CurrentUser() user: UserRecord,
    @Param('id') id: string,
    @Body(new ZodPipe(addTerminalSchema)) body: AddTerminalBody,
    @Res({ passthrough: true }) reply: Reply,
  ): Promise<unknown> {
    const result = await this.service.addTerminal(user.id, id as SessionId, body);
    if (result.kind === 'not-found') throw new NotFoundException();
    if (result.kind === 'forbidden') throw new ForbiddenException();
    if (result.kind === 'conflict') throw new ConflictException();
    reply.status(result.kind === 'created' ? 201 : 200);
    return result.view;
  }

  // S7: partial update answers the new terminal view; non-owners answer 403
  // without learning whether the session or terminal exists; unknown sessions,
  // sessions missing the terminal, or unknown terminals 404.
  @Patch('sessions/:id/terminals/:terminalId')
  async update(
    @CurrentUser() user: UserRecord,
    @Param('id') id: string,
    @Param('terminalId') terminalId: string,
    @Body(new ZodPipe(updateTerminalSchema)) body: UpdateTerminalBody,
  ) {
    const result = await this.service.updateTerminal(
      user.id,
      id as SessionId,
      terminalId as TerminalId,
      body,
    );
    if (result.kind === 'not-found') throw new NotFoundException();
    if (result.kind === 'forbidden') throw new ForbiddenException();
    return result.view;
  }

  // S7: the ids must be exactly the session's terminals; order requests that
  // duplicate, omit or add ids answer 400 without touching stored state.
  @Put('sessions/:id/terminals/order')
  async reorder(
    @CurrentUser() user: UserRecord,
    @Param('id') id: string,
    @Body(new ZodPipe(reorderTerminalsSchema)) body: ReorderTerminalsBody,
  ) {
    const result = await this.service.reorderTerminals(user.id, id as SessionId, body);
    if (result.kind === 'not-found') throw new NotFoundException();
    if (result.kind === 'forbidden') throw new ForbiddenException();
    if (result.kind === 'bad-request') {
      // The rule is the message; the submitted ids never echo back.
      throw new BadRequestException('order must contain exactly the session terminals');
    }
    return result.views;
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
