import { Module, forwardRef } from '@nestjs/common';
import { PeopleService } from './people.service';
import { PeopleController } from './people.controller';
import { AccountsModule } from '../accounts/accounts.module';

@Module({
  imports: [forwardRef(() => AccountsModule)],
  controllers: [PeopleController],
  providers: [PeopleService],
  exports: [PeopleService],
})
export class PeopleModule {}
