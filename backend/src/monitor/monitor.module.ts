import { type DynamicModule, Module } from '@nestjs/common';
import { ConnectorId } from '@ops-console/shared';
import { STORE, type Store } from '../db/store';
import { AlertSessions } from './alert-sessions';
import { AlertsService } from './alerts.service';
import { CliCodeHosts, CODE_HOSTS, CodeFinder, type CodeHosts } from './code-finder';
import { PupDatadog } from './datadog';
import { FixesService } from './fixes.service';
import { LOG_READERS, type LogReader, type LogReaders } from './log-reader';
import { otelLogsConfig } from './log-source-config';
import { MonitorController } from './monitor.controller';
import { OtelLogFolder } from './otel-logs';
import { MonitorRetention } from './retention';
import { ReviewsService } from './reviews.service';
import { ScansService } from './scans.service';
import { ServicesService } from './services.service';
import { VerificationsService } from './verifications.service';

/** Monitor: Scans of the log sources (Datadog, a Log folder), Alerts, Verification, Review and Fix (ADR 0002). */
@Module({})
export class MonitorModule {
  static forRoot(
    config: {
      datadog?: LogReader;
      codeHosts?: CodeHosts;
      /** Bytes a Scan reads from the Log folder at most. */
      otelReadLimit?: number;
    } = {},
  ): DynamicModule {
    return {
      module: MonitorModule,
      global: true,
      controllers: [MonitorController],
      providers: [
        {
          provide: LOG_READERS,
          inject: [STORE],
          useFactory: (store: Store): LogReaders => ({
            [ConnectorId.Datadog]: config.datadog ?? new PupDatadog(),
            [ConnectorId.OtelLogs]: new OtelLogFolder(() => otelLogsConfig(store.db).folder, config.otelReadLimit),
          }),
        },
        { provide: CODE_HOSTS, useValue: config.codeHosts ?? new CliCodeHosts() },
        CodeFinder,
        MonitorRetention,
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
