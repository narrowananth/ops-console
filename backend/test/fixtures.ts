import { Controller, Get, Inject, Injectable, Module, Param, Query } from '@nestjs/common';
import { pageQuerySchema } from '@ops-console/shared';
import { z } from 'zod';
import { parseInput } from '../src/common/errors';
import { afterCursor, toPage } from '../src/common/pagination';
import { SettingsRegistry } from '../src/settings/settings.registry';

/** Two keys registered the way a feature spec registers its own. */
@Injectable()
class FixtureSettings {
  constructor(@Inject(SettingsRegistry) registry: SettingsRegistry) {
    registry.register({ key: 'scan.interval_minutes', schema: z.number().int().min(1).max(60), default: 15 });
    registry.register({ key: 'theme', schema: z.enum(['light', 'dark']), default: 'light' });
  }
}

@Module({ providers: [FixtureSettings] })
export class SettingsFixtureModule {}

const ITEMS = Array.from({ length: 60 }, (_, i) => `item-${String(i + 1).padStart(2, '0')}`);

/** A list endpoint shaped like the ones later specs add. */
@Controller('items')
class ItemsController {
  @Get()
  list(@Query() query: unknown) {
    const { limit, cursor } = parseInput(pageQuerySchema, query, 'query');
    const after = afterCursor(cursor);
    const rows = ITEMS.filter((item) => after === undefined || item > after).slice(0, limit + 1);
    return toPage(rows, limit, (item) => item);
  }

  @Get(':id')
  get(@Param() params: unknown) {
    const { id } = parseInput(z.object({ id: z.uuid() }), params, 'params');
    return { data: { id } };
  }
}

@Module({ controllers: [ItemsController] })
export class ItemsFixtureModule {}
