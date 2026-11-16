import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import {
  type BrowserState,
  chooseFilesBodySchema,
  createTabBodySchema,
  patchTabBodySchema,
  type StagedFile,
  type Tab,
} from '@ops-console/shared';
import type { Request } from 'express';
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

  /** Keeps one file for the page's open file picker; the body is the file, `name` the operator's file name. */
  @Post('browser/tabs/:tabId/files')
  @HttpCode(201)
  async stageFile(
    @Param() params: unknown,
    @Query() query: unknown,
    @Req() request: Request,
  ): Promise<{ data: StagedFile }> {
    const { tabId } = parseInput(tabParams, params, 'params');
    const { name } = parseInput(z.object({ name: z.string().min(1).max(255) }), query, 'query');
    return { data: await this.browser.stageFile(tabId, name, request) };
  }

  /** Hands the staged files to the page's file picker; no ids cancels it. */
  @Post('browser/tabs/:tabId/files/choose')
  @HttpCode(204)
  async chooseFiles(@Param() params: unknown, @Body() body: unknown): Promise<void> {
    const { tabId } = parseInput(tabParams, params, 'params');
    await this.browser.chooseFiles(tabId, parseInput(chooseFilesBodySchema, body, 'body').ids);
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
