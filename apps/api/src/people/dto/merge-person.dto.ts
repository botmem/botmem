import { IsString, IsNotEmpty } from 'class-validator';

export class MergePersonDto {
  @IsString()
  @IsNotEmpty()
  sourceId!: string;
}
