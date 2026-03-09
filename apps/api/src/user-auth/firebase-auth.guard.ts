import {
  Injectable,
  ExecutionContext,
  UnauthorizedException,
  ForbiddenException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CanActivate } from '@nestjs/common';
import { IS_PUBLIC_KEY } from './decorators/public.decorator';
import { REQUIRES_JWT_KEY } from './decorators/requires-jwt.decorator';
import { FirebaseAuthService } from './firebase-auth.service';
import { ApiKeysService } from '../api-keys/api-keys.service';

@Injectable()
export class FirebaseAuthGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private firebaseAuthService: FirebaseAuthService,
    @Inject(forwardRef(() => ApiKeysService))
    private apiKeysService: ApiKeysService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;

    if (!authHeader) throw new UnauthorizedException('Missing Authorization header');

    const token = authHeader.replace(/^Bearer\s+/i, '');

    // Allow API keys (bm_sk_*) to pass through same as JwtAuthGuard
    if (token.startsWith('bm_sk_')) {
      const keyRecord = await this.apiKeysService.validateKey(token);
      if (!keyRecord) throw new UnauthorizedException('Invalid or expired API key');

      const requiresJwt = this.reflector.getAllAndOverride<boolean>(REQUIRES_JWT_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (requiresJwt) throw new ForbiddenException('This endpoint requires full authentication');

      request.user = {
        id: keyRecord.userId,
        apiKeyId: keyRecord.id,
        scopes: ['read'],
        memoryBankIds: keyRecord.memoryBankIds ? JSON.parse(keyRecord.memoryBankIds) : null,
      };
      return true;
    }

    // Verify Firebase ID token
    const decoded = await this.firebaseAuthService.verifyIdToken(token);
    const user = await this.firebaseAuthService.findOrCreateUser(decoded);
    if (!user) throw new UnauthorizedException('User sync failed');

    request.user = { id: user.id, email: user.email };
    return true;
  }
}
