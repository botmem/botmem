import { IsString, IsNotEmpty, IsOptional, IsIn } from 'class-validator';

export class SearchPeopleDto {
  @IsString()
  @IsNotEmpty()
  query!: string;

  @IsOptional()
  @IsString()
  @IsIn(['person', 'group', 'organization', 'device'])
  entityType?: string;
}
