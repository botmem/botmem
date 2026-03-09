import { Module, Global } from '@nestjs/common';
import { CryptoService } from './crypto.service';
import { UserKeyService } from './user-key.service';

@Global()
@Module({
  providers: [CryptoService, UserKeyService],
  exports: [CryptoService, UserKeyService],
})
export class CryptoModule {}
