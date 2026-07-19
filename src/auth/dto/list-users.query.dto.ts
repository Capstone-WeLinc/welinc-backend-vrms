import { IsEnum, IsOptional } from 'class-validator';
import { SystemType } from '@prisma/client';

export class ListUsersQueryDto {
  @IsOptional()
  @IsEnum(SystemType)
  system?: SystemType;
}
