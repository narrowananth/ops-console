import { Controller, Get, Inject } from '@nestjs/common';
import type { Health } from '@ops-console/shared';
import { SESSION, type Session } from './session';

@Controller('health')
export class HealthController {
  constructor(@Inject(SESSION) private readonly session: Session) {}

  @Get()
  get(): { data: Health } {
    return { data: { status: 'ok', version: this.session.version, started_at: this.session.startedAt } };
  }
}
