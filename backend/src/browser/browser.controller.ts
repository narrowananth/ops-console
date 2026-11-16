import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import { type BrowserState, createTabBodySchema, patchTabBodySchema, type Tab } from '@ops-console/shared';
import { z } from 'zod';
import { parseInput } from '../common/errors';
import { BrowserService } from './browser.service';

const sessionParams = z.object({ id: z.string().min(1) });
const tabParams = z.object({ tabId: z.string().min(1) });

@Controller()
export class BrowserController {
  constructor(@Inject(BrowserService) private readonly browser: BrowserService) {}

  @Get('sessions/:id/browser')
  state(@Param() params: unknown): { data: BrowserState } {
    const { id } = parseInput(sessionParams, params, 'params');
    return { data: this.browser.state(id) };
  }

  @Post('sessions/:id/browser/tabs')
  async openTab(@Param() params: unknown, @Body() body: unknown): Promise<{ data: Tab }> {
    const { id } = parseInput(sessionParams, params, 'params');
    const { url } = parseInput(createTabBodySchema, body ?? {}, 'body');
    return { data: (await this.browser.openAddress(id, url)).snapshot() };
  }

  @Patch('browser/tabs/:tabId')
  async patchTab(@Param() params: unknown, @Body() body: unknown): Promise<{ data: Tab }> {
    const { tabId } = parseInput(tabParams, params, 'params');
    return { data: (await this.browser.patch(tabId, parseInput(patchTabBodySchema, body, 'body'))).snapshot() };
  }

  @Delete('browser/tabs/:tabId')
  @HttpCode(204)
  async closeTab(@Param() params: unknown): Promise<void> {
    await this.browser.close(parseInput(tabParams, params, 'params').tabId);
  }

  @Post('browser/tabs/:tabId/external')
  @HttpCode(204)
  async openExternal(@Param() params: unknown): Promise<void> {
    await this.browser.openExternal(parseInput(tabParams, params, 'params').tabId);
  }

  @Post('sessions/:id/browser/clear')
  @HttpCode(204)
  async clear(@Param() params: unknown): Promise<void> {
    await this.browser.clear(parseInput(sessionParams, params, 'params').id);
  }
}
