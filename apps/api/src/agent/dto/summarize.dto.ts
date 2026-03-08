import { IsString, IsNotEmpty, IsOptional, IsInt, Min, Max } from 'class-validator';

export class SummarizeDto {
  @IsString()
  @IsNotEmpty()
  query!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  maxResults?: number;
}
