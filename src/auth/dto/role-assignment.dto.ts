import { IsEnum } from 'class-validator';
import { SystemType, UserRole } from '@prisma/client';

export class RoleAssignmentDto {
  @IsEnum(UserRole)
  role!: UserRole;

  @IsEnum(SystemType)
  system!: SystemType;
}
