import { HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import type { AttachmentKind } from '@prisma/client';

// Spec 0017, API surface: the error bodies the web reads by `code`, with the message it shows.

export function attachmentError(
  status: HttpStatus,
  code: string,
  message: string,
): HttpException {
  return new HttpException({ statusCode: status, code, message }, status);
}

export const noFile = () =>
  attachmentError(
    HttpStatus.BAD_REQUEST,
    'NO_FILE',
    'Choose a file to upload.',
  );

export const forbiddenKind = () =>
  attachmentError(
    HttpStatus.FORBIDDEN,
    'FORBIDDEN_KIND',
    'You can’t add this kind of file to this ticket.',
  );

export const notYourFile = () =>
  attachmentError(
    HttpStatus.FORBIDDEN,
    'NOT_YOUR_FILE',
    'You can only remove files you added yourself.',
  );

export const attachmentNotFound = () =>
  new NotFoundException('Attachment not found');

export const issueNotOnTicket = () =>
  attachmentError(
    HttpStatus.BAD_REQUEST,
    'ISSUE_NOT_ON_TICKET',
    'That issue is not on this ticket. Reload the page and try again.',
  );

export const ticketFinished = (statusLabel: string) =>
  attachmentError(
    HttpStatus.CONFLICT,
    'TICKET_FINISHED',
    `This ticket is ${statusLabel}. Files can no longer change.`,
  );

/** Spec 0018, AC-3: the message names the group that is full. */
export const photoLimitReached = (kind: AttachmentKind, max: number) =>
  attachmentError(
    HttpStatus.CONFLICT,
    'PHOTO_LIMIT_REACHED',
    `This ticket already has ${max} ${kind === 'PROOF' ? 'after' : 'before'} photos, the most allowed. Remove one to add another.`,
  );

export const documentLimitReached = (max: number) =>
  attachmentError(
    HttpStatus.CONFLICT,
    'DOCUMENT_LIMIT_REACHED',
    `This ticket already has ${max} documents, the most allowed. Remove one to add another.`,
  );

export const fileTooLarge = (maxMb: number, actual: string) =>
  attachmentError(
    HttpStatus.PAYLOAD_TOO_LARGE,
    'FILE_TOO_LARGE',
    `Files can be up to ${maxMb} MB. This one is ${actual}.`,
  );

export const fileTypeNotAllowed = (
  kindLabel: string,
  acceptsLabel: string,
  detected: string,
) =>
  attachmentError(
    HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    'FILE_TYPE_NOT_ALLOWED',
    `${kindLabel} accepts ${acceptsLabel}. This file is ${detected}.`,
  );

export const fileUnreadable = () =>
  attachmentError(
    HttpStatus.UNPROCESSABLE_ENTITY,
    'FILE_UNREADABLE',
    'This image could not be read. Try taking the photo again.',
  );

export const pdfUnreadable = () =>
  attachmentError(
    HttpStatus.UNPROCESSABLE_ENTITY,
    'FILE_UNREADABLE',
    'This PDF could not be read. Save or print it as a new PDF and try again.',
  );

export const fileEncrypted = () =>
  attachmentError(
    HttpStatus.UNPROCESSABLE_ENTITY,
    'FILE_ENCRYPTED',
    'Password protected or locked PDFs can’t be attached. Save or print it as a new PDF first.',
  );

export const pdfTooManyPages = (max: number, pageCount: number) =>
  attachmentError(
    HttpStatus.UNPROCESSABLE_ENTITY,
    'PDF_TOO_MANY_PAGES',
    `PDFs can have 1 to ${max} pages. This one has ${pageCount}.`,
  );
