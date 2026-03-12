import { IsString, IsNotEmpty } from 'class-validator';

export class SearchPeopleDto {
  @IsString()
  @IsNotEmpty()
  query!: string;
}
