import { Module } from '@nestjs/common';

import { AuthModule } from './auth/auth.module';
import { CollabGateway } from './collab.gateway';
import { HealthController } from './health.controller';
import { SESSION_STORE, SessionHub, type SessionStore } from './hub';
import { PersistenceModule } from './persistence/persistence.module';
import { RepositorySessionStore } from './persistence/session-store';
import { SessionRepository } from './persistence/session.repository';
import { WorkspaceRepository } from './persistence/workspace.repository';

@Module({
  imports: [AuthModule, PersistenceModule],
  controllers: [HealthController],
  providers: [
    {
      provide: SESSION_STORE,
      useFactory: (sessions: SessionRepository, workspaces: WorkspaceRepository) =>
        new RepositorySessionStore(sessions, workspaces),
      inject: [SessionRepository, WorkspaceRepository],
    },
    { provide: SessionHub, useFactory: (store: SessionStore) => new SessionHub(store), inject: [SESSION_STORE] },
    CollabGateway,
  ],
})
export class AppModule {}
