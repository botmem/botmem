import { IsString, IsNotEmpty } from 'class-validator';

export class CreateAccountDto {
  @IsString()
  @IsNotEmpty()
  connectorType!: string;

  @IsString()
  @IsNotEmpty()
  identifier!: string;
}
