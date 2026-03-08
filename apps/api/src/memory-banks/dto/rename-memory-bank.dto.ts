import { IsString, IsNotEmpty, MaxLength } from 'class-validator';

export class RenameMemoryBankDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;
}
