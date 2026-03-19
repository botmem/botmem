import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsInt,
  Min,
  Max,
  IsBoolean,
  IsArray,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

class TimeRangeDto {
  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;
}

export class SearchMemoriesDto {
  @IsString()
  @IsNotEmpty()
  query!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  connectorTypes?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  sourceTypes?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  factualityLabels?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  personNames?: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => TimeRangeDto)
  timeRange?: TimeRangeDto;

  @IsOptional()
  @IsBoolean()
  pinned?: boolean;

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
