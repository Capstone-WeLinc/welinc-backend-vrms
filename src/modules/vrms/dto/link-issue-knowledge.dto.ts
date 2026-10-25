import { IsBoolean, IsISO8601, IsUUID, ValidateIf } from 'class-validator';

// Spec 0007, AC-29: link, relink (an entry id) or unlink (null) one issue's known fix.
export class LinkIssueKnowledgeDto {
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  knowledgeEntryId: string | null;

  @IsISO8601()
  lastUpdatedAt: string;
}

// Spec 0007, AC-28: tick or untick one copied step.
export class CheckIssueStepDto {
  @IsBoolean()
  checked: boolean;
}
