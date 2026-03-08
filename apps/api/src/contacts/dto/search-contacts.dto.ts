import { IsString, IsNotEmpty } from 'class-validator';

export class SearchContactsDto {
  @IsString()
  @IsNotEmpty()
  query!: string;
}
