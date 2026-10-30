import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { type ErrorBody, ErrorCode } from '@ops-console/shared';
import type { Request, Response } from 'express';
import { ApiError } from './errors';

@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('api');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const { status, body } = this.toEnvelope(exception, request);
    http.getResponse<Response>().status(status).json(body);
  }

  private toEnvelope(exception: unknown, request: Request): { status: number; body: ErrorBody } {
    if (exception instanceof ApiError) {
      return envelope(exception.status, exception.code, exception.message);
    }
    if (exception instanceof HttpException && exception.getStatus() === 404) {
      return envelope(404, ErrorCode.NotFound, `no such path: ${request.method} ${request.path}`);
    }
    // Nest's own 400s come from the body parser, before any route parses the body.
    if (exception instanceof HttpException && exception.getStatus() === 400) {
      return envelope(400, ErrorCode.ValidationFailed, 'invalid body: not valid JSON');
    }
    this.logger.error(exception instanceof Error ? exception : String(exception));
    return envelope(500, ErrorCode.Internal, 'The daemon hit an unexpected error; see the daemon log.');
  }
}

function envelope(status: number, code: ErrorCode, message: string): { status: number; body: ErrorBody } {
  return { status, body: { error: { code, message } } };
}
