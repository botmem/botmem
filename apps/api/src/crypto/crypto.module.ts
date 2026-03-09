import { Module, Global } from '@nestjs/common';
import { CryptoService } from './crypto.service';
import { UserKeyService } from './user-key.service';
import { DekCacheService } from './dek-cache.service';

@Global()
@Module({
  providers: [CryptoService, UserKeyService, DekCacheService],
  exports: [CryptoService, UserKeyService, DekCacheService],
})
export class CryptoModule {}
