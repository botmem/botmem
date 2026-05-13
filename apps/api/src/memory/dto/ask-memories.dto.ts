import {
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class AskMemoriesFiltersDto {
  @IsOptional()
  @IsString()
  sourceType?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  sourceTypes?: string[];

  @IsOptional()
  @IsString()
  connectorType?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  connectorTypes?: string[];

  @IsOptional()
  @IsString()
  contactId?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  contactIds?: string[];

  @IsOptional()
  @IsBoolean()
  fromMe?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  factualityLabels?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  personNames?: string[];

  @IsOptional()
  @IsBoolean()
  pinned?: boolean;

  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;
}

export class AskMemoriesDto {
  @IsString()
  @MinLength(1)
  query!: string;

  @IsOptional()
  @IsString()
  conversationId?: string;

  @IsOptional()
  @IsString()
  memoryBankId?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => AskMemoriesFiltersDto)
  filters?: AskMemoriesFiltersDto;
}
