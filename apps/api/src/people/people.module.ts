import { Module, forwardRef } from '@nestjs/common';
import { PeopleService } from './people.service';
import { PeoplePipelineService } from './people-pipeline.service';
import { PeopleController } from './people.controller';
import { AccountsModule } from '../accounts/accounts.module';
import { ConnectorsModule } from '../connectors/connectors.module';

@Module({
  imports: [forwardRef(() => AccountsModule), ConnectorsModule],
  controllers: [PeopleController],
  providers: [PeopleService, PeoplePipelineService],
  exports: [PeopleService, PeoplePipelineService],
})
export class PeopleModule {}
