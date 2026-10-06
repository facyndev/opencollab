import { Module } from '@nestjs/common';

import { AuthModule } from './auth/auth.module';
import { CollabGateway } from './collab.gateway';
import { HealthController } from './health.controller';

@Module({
  imports: [AuthModule],
  controllers: [HealthController],
  providers: [CollabGateway],
})
export class AppModule {}
