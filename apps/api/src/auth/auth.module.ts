import { Module, forwardRef } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { JobsModule } from '../jobs/jobs.module';
import { ConfigModule } from '../config/config.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { OAuthStateService } from './oauth-state.service';

@Module({
  imports: [AccountsModule, forwardRef(() => JobsModule), ConfigModule],
  controllers: [AuthController],
  providers: [AuthService, OAuthStateService],
  exports: [AuthService],
})
export class AuthModule {}
