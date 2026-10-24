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

import type { WorkspaceId } from '@opencollab/domain';
import { AccessGuard, CurrentUser } from '../auth/access.guard';
import { ZodPipe } from '../auth/dto';
import type { UserRecord } from '../persistence/user.repository';
import {
  createWorkspaceSchema,
  renameWorkspaceSchema,
  type CreateWorkspaceBody,
  type RenameWorkspaceBody,
} from './dto';
import { WorkspaceService } from './workspace.service';

// Status passthrough for the tri-state create (201/200/409): the existing
// @HttpCode annotation cannot express a dynamic code.
interface Reply {
  status(code: number): unknown;
}

@Controller('workspaces')
@UseGuards(AccessGuard)
export class WorkspacesController {
  constructor(@Inject(WorkspaceService) private readonly service: WorkspaceService) {}

  // S7: a fresh id answers 201, an id the caller already owns answers its
  // current view as 200 (idempotent), and a taken id answers 409.
  @Post()
  async create(
    @CurrentUser() user: UserRecord,
    @Body(new ZodPipe(createWorkspaceSchema)) body: CreateWorkspaceBody,
    @Res({ passthrough: true }) reply: Reply,
  ): Promise<unknown> {
    const result = await this.service.create(user.id, body);
    if (result.kind === 'conflict') throw new ConflictException();
    reply.status(result.kind === 'created' ? 201 : 200);
    return result.view;
  }

  @Get()
  list(@CurrentUser() user: UserRecord) {
    return this.service.listFor(user.id);
  }

  @Get(':id')
  async get(@CurrentUser() user: UserRecord, @Param('id') id: string) {
    const result = await this.service.lookup(id as WorkspaceId, user.id);
    if (result.kind === 'not-found') throw new NotFoundException();
    if (result.kind === 'forbidden') throw new ForbiddenException();
    return this.service.detail(result.workspace);
  }

  // S7: rename answers the detail view; members and strangers answer 403,
  // unknown workspaces 404 — same classification as GET detail.
  @Patch(':id')
  async rename(
    @CurrentUser() user: UserRecord,
    @Param('id') id: string,
    @Body(new ZodPipe(renameWorkspaceSchema)) body: RenameWorkspaceBody,
  ) {
    const result = await this.service.rename(user.id, id as WorkspaceId, body.name);
    if (result.kind === 'not-found') throw new NotFoundException();
    if (result.kind === 'forbidden') throw new ForbiddenException();
    return result.view;
  }

  // S7: delete returns 204 with no body; members and strangers answer 403,
  // unknown workspaces 404.
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@CurrentUser() user: UserRecord, @Param('id') id: string) {
    const result = await this.service.remove(user.id, id as WorkspaceId);
    if (result.kind === 'not-found') throw new NotFoundException();
    if (result.kind === 'forbidden') throw new ForbiddenException();
  }
}
