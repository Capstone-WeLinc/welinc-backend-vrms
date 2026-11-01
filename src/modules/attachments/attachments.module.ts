import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import SharedModule from '../../shared/shared.module';
import { AttachmentsController } from './attachments.controller';
import { UploadAccessGuard, UserThrottlerGuard } from './attachments.guard';
import { AttachmentsService } from './attachments.service';
import { BlobFileStore } from './blob-file-store';
import { FILE_STORE } from './file-store';

// Spec 0017: ticket attachments in private Blob Storage, read through short lived signed links
@Module({
  imports: [
    SharedModule,
    // AC-12: no global guard; only the upload route uses UserThrottlerGuard. In memory per replica.
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 30 }]),
  ],
  controllers: [AttachmentsController],
  providers: [
    { provide: FILE_STORE, useClass: BlobFileStore },
    AttachmentsService,
    UploadAccessGuard,
    UserThrottlerGuard,
  ],
  exports: [AttachmentsService],
})
export class AttachmentsModule {}
