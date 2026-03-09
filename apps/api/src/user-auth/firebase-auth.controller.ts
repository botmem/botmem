import { Controller, Post, Body, HttpCode, UnauthorizedException } from '@nestjs/common';
import { Public } from './decorators/public.decorator';
import { FirebaseAuthService } from './firebase-auth.service';
import { UsersService } from './users.service';

@Controller('firebase-auth')
export class FirebaseAuthController {
  constructor(
    private firebaseAuthService: FirebaseAuthService,
    private usersService: UsersService,
  ) {}

  /**
   * Exchange a Firebase ID token for a local user record.
   * Called by the frontend after Firebase signInWith* succeeds.
   * Returns recoveryKey for new users (shown once) and needsRecoveryKey flag.
   */
  @Public()
  @Post('sync')
  @HttpCode(200)
  async syncUser(@Body() body: { idToken: string }) {
    if (!body.idToken) throw new UnauthorizedException('idToken is required');
    const decoded = await this.firebaseAuthService.verifyIdToken(body.idToken);
    const result = await this.firebaseAuthService.findOrCreateUser(decoded);
    if (!result.user) throw new UnauthorizedException('User sync failed');
    return {
      user: {
        id: result.user.id,
        email: result.user.email,
        name: result.user.name,
        onboarded: !!result.user.onboarded,
        createdAt: result.user.createdAt,
      },
      recoveryKey: result.recoveryKey,
      needsRecoveryKey: result.needsRecoveryKey,
    };
  }
}
