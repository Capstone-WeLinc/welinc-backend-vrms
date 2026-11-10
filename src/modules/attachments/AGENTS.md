# Attachments (ticket files)

Photos, proof, receipts and other documents on a repair ticket, stored in private Blob Storage and opened through short lived signed links. Governing spec: [docs/specs/vrms/0017-file-upload-storage/index.md](../../../../docs/specs/vrms/0017-file-upload-storage/index.md) (its AC numbers appear in code comments and tests).

## Key files

| File | Owns |
|---|---|
| `attachments.controller.ts`, `attachments.guard.ts`, `upload.interceptor.ts` | The routes under `/vrms/repairs/:id/attachments`. `UploadAccessGuard` runs before the file interceptor, so the body is not read for a ticket the caller cannot see. `UserThrottlerGuard` limits 30 uploads a minute per signed in user, counted per replica |
| `attachments.service.ts` | List, upload and remove, and the error order (AC-12b): visibility 404, add right 403, ticket finished 409, size 413, empty 400, type 415, issue tag 400, duplicate, caps 409, then the file rebuild 422. Upload, remove and move lock the ticket row inside the transaction and never write to the ticket. Spec 0018: the web uploads photos as `PHOTO` and the server derives Before (`VEHICLE_PHOTO`) or After (`PROOF`) from `workStartedAt` under the lock, unless the upload names its `group` (spec 0024, AC-21: a drop zone or Before's late tile; on a document it answers 400 `GROUP_NOT_FOR_DOCUMENTS`); `PATCH …/attachments/:attachmentId` moves a photo (`canMove`, `BEFORE_PHOTO_PROTECTED`) |
| `attachment-kinds.ts`, `attachment-errors.ts` | The four kinds with their accepted types, add right and costs only flag, and every error body the web reads by `code` |
| `file-sniff.ts`, `image-pipeline.ts`, `pdf-pipeline.ts`, `semaphore.ts` | The type comes from the first bytes. Images are rebuilt with sharp (JPEG and a WebP thumbnail, EXIF stripped, HEIC converted). PDFs are rebuilt with pdf-lib (scripts, embedded files, form fields and unsafe links removed). The semaphore limits concurrent rebuilds |
| `file-store.ts`, `blob-file-store.ts` | The `FileStore` seam and the only code that talks to Azure. It builds the signed links (`linkWindow`) and the `Content-Disposition` header |
| `attachment-purge.job.ts` | Nightly at 03:00 Manila, plus a pass 2 minutes after boot when rows are due: purges files 30 days after removal and sweeps orphan blobs older than 24 hours, under an advisory lock |

## Conventions

- No uploaded bytes are stored unchanged. Anything new that accepts a file goes through `AttachmentsService.upload` with a new kind in `attachment-kinds.ts`, never a second upload path.
- Blobs are written before the database row and deleted again if anything after the first write fails. Keep that order on any new write path.
- Receipts and other documents are `costsOnly`: without `ticket.costs.view` they are left out of the list, their delete is 404, and their audit events are hidden (`hiddenAuditEvents` in the audit readers, which also hides `COST_UPDATE`). Use `visibleKinds()` for any new query.
- The four limits (`uploads.max_file_mb`, `uploads.max_vehicle_photos` for Before, `uploads.max_after_photos` for After, `uploads.max_documents`) come from `SettingsService` on every request, never from constants.
- Links are stable inside a 10 minute window so browsers can cache them. Do not add per request randomness to a link.

## Gotchas

- Set `STORAGE_CONNECTION_STRING` (Azurite, local) or `STORAGE_ACCOUNT_URL` (Azure, managed identity). With neither the app starts and every attachment route answers 503 `STORAGE_UNAVAILABLE`. `docker-compose.vrms.yml` runs Azurite on port 10000, and links for the browser use `STORAGE_PUBLIC_URL`.
- The shared gateway allows 26 MB bodies and a 120 s read timeout on `/vrms/` (`infra/gateway/` in the workspace, spec 0008), or large uploads would fail before they reach this module.
- `sharp` and `heic-convert` are native or heavy: a Docker image change can break them, so run the `image-pipeline` spec after any base image bump.

_Drafted by /sync from the introducing change, worth a quick human pass._
