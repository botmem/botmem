import { IsString, IsNotEmpty, MaxLength } from 'class-validator';

export class CreateMemoryBankDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;
}
