import { IsArray, IsString, ArrayMinSize } from 'class-validator';

export class SplitPersonDto {
  @IsArray()
  @IsString({ each: true })
  @ArrayMinSize(1)
  identifierIds!: string[];
}
