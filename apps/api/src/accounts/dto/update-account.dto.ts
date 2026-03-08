import { IsOptional, IsString, IsIn } from 'class-validator';

export class UpdateAccountDto {
  @IsOptional()
  @IsString()
  @IsIn(['manual', 'hourly', 'daily', 'weekly'])
  schedule?: string;
}
