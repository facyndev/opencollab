import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PersistenceModule } from '../persistence/persistence.module';
import { WorkspacesController } from './workspaces.controller';
import { WorkspaceService } from './workspace.service';

@Module({
  imports: [PersistenceModule, AuthModule],
  controllers: [WorkspacesController],
  providers: [WorkspaceService],
  exports: [WorkspaceService],
})
export class CollabModule {}
