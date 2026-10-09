import { Controller, Get, Header } from '@nestjs/common';

/**
 * Liveness probe. Contract with the desktop (`HttpRelayProbe`): success is
 * ONLY `200` with body `ok`. Keep it plain text and exact.
 */
@Controller()
export class HealthController {
  @Get('health')
  @Header('Content-Type', 'text/plain')
  check(): string {
    return 'ok';
  }
}
