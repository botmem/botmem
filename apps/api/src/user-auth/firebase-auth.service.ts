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
      const saJson = this.config.firebaseServiceAccount;
      const credential = saJson
        ? admin.credential.cert(JSON.parse(saJson))
        : admin.credential.applicationDefault();

      this.app = admin.initializeApp({ credential, projectId: this.config.firebaseProjectId });
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
    // Only match on firebase_uid — never fall back to email for identity resolution
    const user = await this.usersService.findByFirebaseUid(decoded.uid);
    if (user) return user;

    // No matching user — create a new account for this Firebase identity
    const email = decoded.email ?? `${decoded.uid}@firebase.user`;

    // Create new local user record for first-time Firebase login
    const name = decoded.name ?? decoded.email?.split('@')[0] ?? 'User';
    const passwordHash = `firebase:${decoded.uid}`; // sentinel — never compared via bcrypt
    const encryptionSalt = randomBytes(16).toString('base64');

    const newUser = await this.usersService.createUser(email, passwordHash, name, encryptionSalt);
    await this.usersService.setFirebaseUid(newUser!.id, decoded.uid);
    await this.memoryBanksService.getOrCreateDefault(newUser!.id);

    this.logger.log(`Created local user ${newUser!.id} for Firebase UID ${decoded.uid}`);
    return this.usersService.findById(newUser!.id);
  }
}
