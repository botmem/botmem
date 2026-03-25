import { IsString, MinLength } from 'class-validator';

export class ChangePasswordDto {
  @IsString()
  @MinLength(12)
  oldPassword!: string;

  @IsString()
  @MinLength(12)
  newPassword!: string;
}
