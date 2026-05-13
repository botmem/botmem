import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsInt,
  Min,
  Max,
  ValidateNested,
  IsBoolean,
  IsArray,
} from 'class-validator';
import { Type } from 'class-transformer';

export class AskFiltersDto {
  @IsOptional()
  @IsString()
  sourceType?: string;

  @IsOptional()
  @IsString()
  connectorType?: string;

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
}

export class AskDto {
  @IsString()
  @IsNotEmpty()
  query!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => AskFiltersDto)
  filters?: AskFiltersDto;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
