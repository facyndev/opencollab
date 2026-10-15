import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PersistenceModule } from '../persistence/persistence.module';
import { SessionService } from './session.service';
import { SessionsController } from './sessions.controller';
import { WorkspacesController } from './workspaces.controller';
import { WorkspaceService } from './workspace.service';

@Module({
  imports: [PersistenceModule, AuthModule],
  controllers: [WorkspacesController, SessionsController],
  providers: [WorkspaceService, SessionService],
  exports: [WorkspaceService, SessionService],
})
export class CollabModule {}
