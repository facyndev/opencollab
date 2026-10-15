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

import type { WorkspaceId } from '@opencollab/domain';
import { AccessGuard, CurrentUser } from '../auth/access.guard';
import { ZodPipe } from '../auth/dto';
import type { UserRecord } from '../persistence/user.repository';
import { createWorkspaceSchema, type CreateWorkspaceBody } from './dto';
import { WorkspaceService } from './workspace.service';

@Controller('workspaces')
@UseGuards(AccessGuard)
export class WorkspacesController {
  constructor(@Inject(WorkspaceService) private readonly service: WorkspaceService) {}

  @Post()
  @HttpCode(201)
  create(
    @CurrentUser() user: UserRecord,
    @Body(new ZodPipe(createWorkspaceSchema)) body: CreateWorkspaceBody,
  ) {
    return this.service.create(user.id, body.name);
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
}
