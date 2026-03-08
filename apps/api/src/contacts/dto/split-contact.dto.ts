import { IsArray, IsString, ArrayMinSize } from 'class-validator';

export class SplitContactDto {
  @IsArray()
  @IsString({ each: true })
  @ArrayMinSize(1)
  identifierIds!: string[];
}
