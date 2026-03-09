import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module';
import { DbModule } from '../db/db.module';
import { FirebaseAuthService } from './firebase-auth.service';
import { FirebaseAuthGuard } from './firebase-auth.guard';
import { FirebaseAuthController } from './firebase-auth.controller';
import { UsersService } from './users.service';
import { MemoryBanksModule } from '../memory-banks/memory-banks.module';
import { ApiKeysModule } from '../api-keys/api-keys.module';

@Module({
  imports: [ConfigModule, DbModule, MemoryBanksModule, ApiKeysModule],
  controllers: [FirebaseAuthController],
  providers: [FirebaseAuthService, FirebaseAuthGuard, UsersService],
  exports: [FirebaseAuthGuard, FirebaseAuthService],
})
export class FirebaseAuthModule {}
