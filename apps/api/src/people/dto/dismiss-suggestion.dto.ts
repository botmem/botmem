import { IsString, IsNotEmpty } from 'class-validator';

export class DismissSuggestionDto {
  @IsString()
  @IsNotEmpty()
  contactId1!: string;

  @IsString()
  @IsNotEmpty()
  contactId2!: string;
}
