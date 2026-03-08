import {
  Injectable,
  ExecutionContext,
  UnauthorizedException,
  ForbiddenException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from './decorators/public.decorator';
import { REQUIRES_JWT_KEY } from './decorators/requires-jwt.decorator';
import { ApiKeysService } from '../api-keys/api-keys.service';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(
    private reflector: Reflector,
    @Inject(forwardRef(() => ApiKeysService))
    private apiKeysService: ApiKeysService,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;

    if (authHeader) {
      const token = authHeader.replace(/^Bearer\s+/i, '');

      if (token.startsWith('bm_sk_')) {
        const keyRecord = await this.apiKeysService.validateKey(token);
        if (!keyRecord) {
          throw new UnauthorizedException('Invalid or expired API key');
        }

        // Check if endpoint requires JWT (blocks API key access)
        const requiresJwt = this.reflector.getAllAndOverride<boolean>(REQUIRES_JWT_KEY, [
          context.getHandler(),
          context.getClass(),
        ]);
        if (requiresJwt) {
          throw new ForbiddenException('This endpoint requires full authentication');
        }

        request.user = {
          id: keyRecord.userId,
          apiKeyId: keyRecord.id,
          scopes: ['read'],
          bankIds: keyRecord.bankIds ? JSON.parse(keyRecord.bankIds) : null,
        };
        return true;
      }
    }

    // Default: JWT auth via Passport
    return super.canActivate(context) as Promise<boolean>;
  }
}
