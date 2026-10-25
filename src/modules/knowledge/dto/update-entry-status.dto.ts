import { IsEnum, IsISO8601 } from 'class-validator';
import { KnowledgeEntryStatus } from '@prisma/client';

export class UpdateEntryStatusDto {
  @IsEnum(KnowledgeEntryStatus)
  status: KnowledgeEntryStatus;

  @IsISO8601()
  lastUpdatedAt: string;
}
