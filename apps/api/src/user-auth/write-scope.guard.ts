import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from './decorators/public.decorator';
import { IS_READ_ONLY_KEY } from './decorators/read-only.decorator';

/**
 * Global guard that enforces write scope on API keys.
 *
 * API keys are issued with `scopes: ['read']` only. This guard rejects
 * mutating HTTP methods (POST, PUT, PATCH, DELETE) when the request is
 * authenticated via an API key whose scopes do not include 'write'.
 *
 * Endpoints decorated with @ReadOnly() are exempt — they use POST for
 * request bodies but are semantically read operations (e.g. search, ask).
 *
 * Regular JWT/Firebase users are unaffected (they have no `isApiKey` flag
 * and no `scopes` restriction).
 */
@Injectable()
export class WriteScopeGuard implements CanActivate {
  private static readonly WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Skip public endpoints
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    // Not an API key request — allow
    if (!user?.apiKeyId) return true;

    // Safe methods — allow regardless of scopes
    if (!WriteScopeGuard.WRITE_METHODS.has(request.method)) return true;

    // @ReadOnly() endpoints use POST but are semantically reads — allow
    const isReadOnly = this.reflector.getAllAndOverride<boolean>(IS_READ_ONLY_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isReadOnly) return true;

    // API key request with a write method — check scopes
    const scopes: string[] = user.scopes || [];
    if (!scopes.includes('write')) {
      throw new ForbiddenException(
        'API key does not have write scope. This endpoint requires write access.',
      );
    }

    return true;
  }
}
