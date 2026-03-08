import { IsString, IsNotEmpty, MaxLength, IsOptional } from 'class-validator';

export class CreateApiKeyDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @IsOptional()
  @IsString()
  expiresAt?: string;
}
