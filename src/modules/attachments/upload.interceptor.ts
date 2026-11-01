import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import multer, { MulterError } from 'multer';
import type { Observable } from 'rxjs';
import { fileTooLarge, noFile } from './attachment-errors';

/** AC-5: the hard cap multer holds in memory. The size setting is checked after, in the service. */
export const MULTER_MAX_MB = 25;
export const MULTER_MAX_BYTES = MULTER_MAX_MB * 1024 * 1024 + 1;

const single = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MULTER_MAX_BYTES, files: 1, fields: 5 },
}).single('file');

/** The multer error answered as the spec's body (AC-5). */
export function multerErrorResponse(error: MulterError) {
  switch (error.code) {
    case 'LIMIT_FILE_SIZE':
      return fileTooLarge(MULTER_MAX_MB, `over ${MULTER_MAX_MB} MB`);
    case 'LIMIT_UNEXPECTED_FILE':
    case 'LIMIT_FILE_COUNT':
      return noFile();
    default:
      return new BadRequestException({
        statusCode: 400,
        code: 'BAD_UPLOAD',
        message: 'This upload could not be read. Try again.',
      });
  }
}

/**
 * Spec 0017: buffers one `file` field in memory, after the route guards (AC-12a). Used instead of
 * Nest's FileInterceptor so multer's own error codes map to the spec's bodies.
 */
@Injectable()
export class SingleFileInterceptor implements NestInterceptor {
  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    await new Promise<void>((resolve, reject) => {
      single(request, response, (error: unknown) => {
        if (!error) return resolve();
        if (error instanceof MulterError) {
          return reject(multerErrorResponse(error));
        }
        reject(error instanceof Error ? error : new Error('Upload failed'));
      });
    });
    return next.handle();
  }
}
