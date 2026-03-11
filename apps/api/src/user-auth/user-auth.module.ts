import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '../config/config.module';
import { ConfigService } from '../config/config.service';
import { DbModule } from '../db/db.module';
import { MailModule } from '../mail/mail.module';
import { CryptoModule } from '../crypto/crypto.module';
import { UserAuthService } from './user-auth.service';
import { CliAuthService } from './cli-auth.service';
import { UsersService } from './users.service';
import { UserAuthController } from './user-auth.controller';
import { JwtStrategy } from './jwt.strategy';
import { JwtAuthGuard } from './jwt-auth.guard';

@Module({
  imports: [
    ConfigModule,
    DbModule,
    MailModule,
    CryptoModule,
    BullModule.registerQueue({ name: 'reencrypt' }),
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.jwtAccessSecret,
        signOptions: {
          expiresIn: config.jwtAccessExpiresIn as string | number,
          algorithm: 'HS256' as const,
        },
      }),
    }),
  ],
  controllers: [UserAuthController],
  providers: [UserAuthService, CliAuthService, UsersService, JwtStrategy, JwtAuthGuard],
  exports: [JwtAuthGuard, JwtStrategy, UsersService],
})
export class UserAuthModule {}
