import { IsIn } from 'class-validator';

export class ReleaseTicketsDto {
  @IsIn(['DEACTIVATED', 'ROLE_REMOVED'])
  reason: 'DEACTIVATED' | 'ROLE_REMOVED';
}
