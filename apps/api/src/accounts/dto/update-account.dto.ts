import { IsOptional, IsString, IsIn } from 'class-validator';
import type { SyncSchedule } from '@botmem/shared';

export class UpdateAccountDto {
  @IsOptional()
  @IsString()
  @IsIn(['manual', 'hourly', 'every-6h', 'daily'])
  schedule?: SyncSchedule;
}
