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
   * Returns user profile. The frontend uses the Firebase ID token directly
   * as the Bearer token for all subsequent API calls.
   */
  @Public()
  @Post('sync')
  @HttpCode(200)
  async syncUser(@Body() body: { idToken: string }) {
    if (!body.idToken) throw new UnauthorizedException('idToken is required');
    const decoded = await this.firebaseAuthService.verifyIdToken(body.idToken);
    const user = await this.firebaseAuthService.findOrCreateUser(decoded);
    if (!user) throw new UnauthorizedException('User sync failed');
    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        onboarded: !!user.onboarded,
        createdAt: user.createdAt,
      },
    };
  }
}
