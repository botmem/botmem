import { IsOptional, IsString, IsArray, IsObject, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class AvatarDto {
  @IsString()
  url!: string;

  @IsString()
  source!: string;
}

export class UpdatePersonDto {
  @IsOptional()
  @IsString()
  displayName?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AvatarDto)
  avatars?: AvatarDto[];

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
