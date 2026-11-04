import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Res } from '@nestjs/common';
import { addNetworkDomainSchema, type NetworkAllowlist } from '@ops-console/shared';
import type { Response } from 'express';
import { z } from 'zod';
import { parseInput, validationFailed } from '../common/errors';
import { NetworkAllowlistService } from './network-allowlist.service';

const domainParams = z.object({ domain: z.string().trim().toLowerCase().min(1) });

/** Setup agent > Permissions: the hosts agent runs may reach. */
@Controller('network-allowlist')
export class NetworkAllowlistController {
  constructor(@Inject(NetworkAllowlistService) private readonly allowlist: NetworkAllowlistService) {}

  @Get()
  read(): { data: NetworkAllowlist } {
    return { data: this.allowlist.read() };
  }

  /** 201 for a new domain, 200 with the same body when some group already has it. */
  @Post('domains')
  add(@Body() body: unknown, @Res({ passthrough: true }) res: Response): { data: { domain: string } } {
    // The refusal's own message is what the operator reads, so it is not folded into `invalid body: domain`.
    const parsed = addNetworkDomainSchema.safeParse(body);
    if (!parsed.success) throw validationFailed(parsed.error.issues[0]?.message ?? 'invalid domain');
    const { domain, created } = this.allowlist.add(parsed.data.domain);
    res.status(created ? 201 : 200);
    return { data: { domain } };
  }

  @Delete('domains/:domain')
  @HttpCode(204)
  remove(@Param() params: unknown): void {
    this.allowlist.remove(parseInput(domainParams, params, 'params').domain);
  }
}
