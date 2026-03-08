import { IsString, IsNotEmpty, IsOptional, IsObject } from 'class-validator';

export class RememberDto {
  @IsString()
  @IsNotEmpty()
  text!: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
