import { type DynamicModule, Module } from '@nestjs/common';
import { BrowserController } from './browser.controller';
import { BrowserService } from './browser.service';
import { BrowserGateway } from './browser-gateway';
import { BROWSER_OPTIONS, type BrowserOptions } from './browser-options';
import { BrowserToolsService } from './browser-tools.service';

/** Each Session's Chrome, its tabs, the page stream to the Browser panel and the tools the agent drives it with. */
@Module({})
export class BrowserModule {
  static forRoot(options: BrowserOptions = {}): DynamicModule {
    return {
      module: BrowserModule,
      global: true,
      controllers: [BrowserController],
      providers: [{ provide: BROWSER_OPTIONS, useValue: options }, BrowserService, BrowserToolsService, BrowserGateway],
      exports: [BrowserService, BrowserToolsService],
    };
  }
}
