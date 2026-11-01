import { Module } from '@nestjs/common';
import SharedModule from '../../shared/shared.module';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';
import { BlobFileStore } from './blob-file-store';
import { FILE_STORE } from './file-store';

// Spec 0017: ticket attachments in private Blob Storage, read through short lived signed links
@Module({
  imports: [SharedModule],
  controllers: [AttachmentsController],
  providers: [
    { provide: FILE_STORE, useClass: BlobFileStore },
    AttachmentsService,
  ],
  exports: [AttachmentsService],
})
export class AttachmentsModule {}
