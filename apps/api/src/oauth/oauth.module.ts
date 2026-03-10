import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { UserAuthModule } from '../user-auth/user-auth.module';
import { CryptoModule } from '../crypto/crypto.module';
import { OAuthService } from './oauth.service';
import { OAuthController } from './oauth.controller';
import { OAuthMetadataController } from './oauth-metadata.controller';

@Module({
  imports: [
    UserAuthModule,
    CryptoModule,
    JwtModule.register({}),
  ],
  controllers: [OAuthController, OAuthMetadataController],
  providers: [OAuthService],
  exports: [OAuthService],
})
export class OAuthModule {}
