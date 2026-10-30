import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import { ErrorCode } from '@ops-console/shared';
import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../common/errors';
import { SESSION, type Session } from '../common/session';

/**
 * Every `/api` request needs `Authorization: Bearer <token>` (ADR 0003). A middleware, not a guard, so an
 * unknown path without the token is refused before routing can answer `not_found`.
 */
@Injectable()
export class AuthMiddleware implements NestMiddleware {
  constructor(@Inject(SESSION) private readonly session: Session) {}

  use(request: Request, _response: Response, next: NextFunction): void {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
    if (!this.session.accepts(token)) {
      throw new ApiError(401, ErrorCode.Unauthorized, 'Missing or wrong session token. Run `ops-console open`.');
    }
    next();
  }
}
