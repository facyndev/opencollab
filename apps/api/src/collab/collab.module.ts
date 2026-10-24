import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PersistenceModule } from '../persistence/persistence.module';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';
import { SessionService } from './session.service';
import { SessionsController } from './sessions.controller';
import { TerminalsController } from './terminals.controller';
import { WorkspacesController } from './workspaces.controller';
import { WorkspaceService } from './workspace.service';

@Module({
  imports: [PersistenceModule, AuthModule],
  controllers: [WorkspacesController, SessionsController, TerminalsController, InvitationsController],
  providers: [WorkspaceService, SessionService, InvitationsService],
  exports: [WorkspaceService, SessionService, InvitationsService],
})
export class CollabModule {}
