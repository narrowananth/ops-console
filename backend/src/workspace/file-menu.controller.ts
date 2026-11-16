import { Controller, Get, Inject, Query } from '@nestjs/common';
import { type FileMenu, fileMenuQuerySchema } from '@ops-console/shared';
import { parseInput } from '../common/errors';
import { FileMenuService } from './file-menu.service';

/** The `@` menu above a Session's composer. */
@Controller('file-menu')
export class FileMenuController {
  constructor(@Inject(FileMenuService) private readonly menu: FileMenuService) {}

  @Get()
  async list(@Query() query: unknown): Promise<{ data: FileMenu }> {
    return { data: await this.menu.menu(parseInput(fileMenuQuerySchema, query, 'query')) };
  }
}
