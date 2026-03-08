import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule } from '../config/config.module';
import { ConfigService } from '../config/config.service';
import { DbModule } from '../db/db.module';
import { MailModule } from '../mail/mail.module';
import { UserAuthService } from './user-auth.service';
import { UsersService } from './users.service';
import { UserAuthController } from './user-auth.controller';
import { JwtStrategy } from './jwt.strategy';
import { JwtAuthGuard } from './jwt-auth.guard';

@Module({
  imports: [
    ConfigModule,
    DbModule,
    MailModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.jwtAccessSecret,
        signOptions: {
          expiresIn: config.jwtAccessExpiresIn as any,
          algorithm: 'HS256' as const,
        },
      }),
    }),
  ],
  controllers: [UserAuthController],
  providers: [UserAuthService, UsersService, JwtStrategy, JwtAuthGuard],
  exports: [JwtAuthGuard, JwtStrategy, UsersService],
})
export class UserAuthModule {}
