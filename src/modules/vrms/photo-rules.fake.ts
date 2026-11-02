import { AttachmentKind } from '@prisma/client';

/**
 * The rows `attachment.groupBy` answers in unit tests, for the live photo counts livePhotoCounts
 * reads (spec 0018). Defaults to one Before and one After photo, so no photo rule blocks a move.
 */
export function photoRows(before = 1, after = 1) {
  return [
    { kind: AttachmentKind.VEHICLE_PHOTO, _count: { _all: before } },
    { kind: AttachmentKind.PROOF, _count: { _all: after } },
  ].filter((row) => row._count._all > 0);
}
