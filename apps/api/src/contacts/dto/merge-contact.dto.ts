import { IsString, IsNotEmpty } from 'class-validator';

export class MergeContactDto {
  @IsString()
  @IsNotEmpty()
  sourceId!: string;
}
