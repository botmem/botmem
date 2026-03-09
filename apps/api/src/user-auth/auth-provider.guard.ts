import { Injectable, ExecutionContext } from '@nestjs/common';
import { CanActivate } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { FirebaseAuthGuard } from './firebase-auth.guard';

/**
 * Delegates to JwtAuthGuard (default) or FirebaseAuthGuard based on AUTH_PROVIDER env var.
 * This is the single APP_GUARD registered in AppModule.
 */
@Injectable()
export class AuthProviderGuard implements CanActivate {
  constructor(
    private config: ConfigService,
    private jwtGuard: JwtAuthGuard,
    private firebaseGuard: FirebaseAuthGuard,
  ) {}

  canActivate(context: ExecutionContext): Promise<boolean> | boolean {
    if (this.config.authProvider === 'firebase') {
      return this.firebaseGuard.canActivate(context) as Promise<boolean>;
    }
    return this.jwtGuard.canActivate(context) as Promise<boolean>;
  }
}
