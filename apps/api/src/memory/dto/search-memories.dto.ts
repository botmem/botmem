import { IsString, IsNotEmpty, IsOptional, IsObject, IsInt, Min, Max, IsBoolean } from 'class-validator';

export class SearchMemoriesDto {
  @IsString()
  @IsNotEmpty()
  query!: string;

  @IsOptional()
  @IsObject()
  filters?: Record<string, string>;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsBoolean()
  rerank?: boolean;

  @IsOptional()
  @IsString()
  memoryBankId?: string;
}
