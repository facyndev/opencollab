import { Module } from '@nestjs/common';

import { CollabGateway } from './collab.gateway';
import { HealthController } from './health.controller';

@Module({
  controllers: [HealthController],
  providers: [CollabGateway],
})
export class AppModule {}
