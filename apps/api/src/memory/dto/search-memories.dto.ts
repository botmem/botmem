import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsInt,
  IsNumber,
  IsBoolean,
  Min,
  Max,
  IsArray,
  IsObject,
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
  @Max(250)
  limit?: number;

  @IsOptional()
  @IsString()
  memoryBankId?: string;

  /** Legacy CLI/API filters shape: { connectorType, sourceType, contactId, ... } */
  @IsOptional()
  @IsObject()
  filters?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  connectorType?: string;

  @IsOptional()
  @IsString()
  sourceType?: string;

  @IsOptional()
  @IsString()
  contactId?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  diversityFactor?: number;

  @IsOptional()
  @IsBoolean()
  debug?: boolean;

  @IsOptional()
  @IsBoolean()
  fromMe?: boolean;
}
