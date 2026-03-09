import { Injectable, Logger, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import * as admin from 'firebase-admin';
import { randomBytes } from 'crypto';
import { ConfigService } from '../config/config.service';
import { UsersService } from './users.service';
import { MemoryBanksService } from '../memory-banks/memory-banks.service';

@Injectable()
export class FirebaseAuthService implements OnModuleInit {
  private readonly logger = new Logger(FirebaseAuthService.name);
  private app!: admin.app.App;

  constructor(
    private config: ConfigService,
    private usersService: UsersService,
    private memoryBanksService: MemoryBanksService,
  ) {}

  onModuleInit() {
    if (admin.apps.length === 0) {
      this.app = admin.initializeApp({
        projectId: this.config.firebaseProjectId,
      });
      this.logger.log(`Firebase Admin initialized for project: ${this.config.firebaseProjectId}`);
    } else {
      this.app = admin.apps[0]!;
    }
  }

  async verifyIdToken(idToken: string): Promise<admin.auth.DecodedIdToken> {
    try {
      return await this.app.auth().verifyIdToken(idToken);
    } catch {
      throw new UnauthorizedException('Invalid Firebase ID token');
    }
  }

  /**
   * Find existing user by firebaseUid or create a new local user record.
   * Firebase users have a sentinel passwordHash ('firebase:<uid>') — they never use password login.
   */
  async findOrCreateUser(decoded: admin.auth.DecodedIdToken) {
    // Try to find by firebase UID first
    let user = await this.usersService.findByFirebaseUid(decoded.uid);
    if (user) return user;

    // Try to find by email (user may have registered locally before)
    const email = decoded.email ?? `${decoded.uid}@firebase.user`;
    user = await this.usersService.findByEmail(email);

    if (user) {
      // Link the firebase UID to the existing local account
      await this.usersService.setFirebaseUid(user.id, decoded.uid);
      return this.usersService.findById(user.id);
    }

    // Create new local user record for first-time Firebase login
    const name = decoded.name ?? decoded.email?.split('@')[0] ?? 'User';
    const passwordHash = `firebase:${decoded.uid}`; // sentinel — never compared via bcrypt
    const encryptionSalt = randomBytes(16).toString('base64');

    user = await this.usersService.createUser(email, passwordHash, name, encryptionSalt);
    await this.usersService.setFirebaseUid(user!.id, decoded.uid);
    await this.memoryBanksService.getOrCreateDefault(user!.id);

    this.logger.log(`Created local user ${user!.id} for Firebase UID ${decoded.uid}`);
    return this.usersService.findById(user!.id);
  }
}
