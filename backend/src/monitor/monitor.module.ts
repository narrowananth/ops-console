import { type DynamicModule, Module } from '@nestjs/common';
import { AlertSessions } from './alert-sessions';
import { AlertsService } from './alerts.service';
import { DATADOG_READER, type DatadogReader, PupDatadog } from './datadog';
import { FixesService } from './fixes.service';
import { MonitorController } from './monitor.controller';
import { ReviewsService } from './reviews.service';
import { ScansService } from './scans.service';
import { ServicesService } from './services.service';
import { VerificationsService } from './verifications.service';

/** Monitor: Scans of Datadog, Alerts, Verification, Review and Fix (ADR 0002). */
@Module({})
export class MonitorModule {
  static forRoot(config: { datadog?: DatadogReader } = {}): DynamicModule {
    return {
      module: MonitorModule,
      global: true,
      controllers: [MonitorController],
      providers: [
        { provide: DATADOG_READER, useValue: config.datadog ?? new PupDatadog() },
        AlertsService,
        ServicesService,
        AlertSessions,
        ScansService,
        VerificationsService,
        FixesService,
        ReviewsService,
      ],
      exports: [ScansService, AlertsService, FixesService, ReviewsService],
    };
  }
}
