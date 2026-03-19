import { IsString, IsOptional, MinLength } from 'class-validator';

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
}
