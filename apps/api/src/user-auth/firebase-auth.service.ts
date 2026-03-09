import { Injectable, Logger, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import * as admin from 'firebase-admin';
import { createHash, randomBytes } from 'crypto';
import { ConfigService } from '../config/config.service';
import { UsersService } from './users.service';
import { MemoryBanksService } from '../memory-banks/memory-banks.service';
import { UserKeyService } from '../crypto/user-key.service';

@Injectable()
export class FirebaseAuthService implements OnModuleInit {
  private readonly logger = new Logger(FirebaseAuthService.name);
  private app!: admin.app.App;

  constructor(
    private config: ConfigService,
    private usersService: UsersService,
    private memoryBanksService: MemoryBanksService,
    private userKeyService: UserKeyService,
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

  private hashRecoveryKey(recoveryKey: string): string {
    return createHash('sha256').update(recoveryKey).digest('hex');
  }

  /**
   * Find existing user by firebaseUid or create a new local user record.
   * Returns recoveryKey for new users (shown once), needsRecoveryKey for existing users with cold cache.
   */
  async findOrCreateUser(decoded: admin.auth.DecodedIdToken) {
    const user = await this.usersService.findByFirebaseUid(decoded.uid);
    if (user) {
      // Existing user — try 2-tier DEK lookup
      const dek = await this.userKeyService.getDek(user.id);
      const needsRecoveryKey = !dek && !!user.recoveryKeyHash;
      return { user, recoveryKey: undefined, needsRecoveryKey };
    }

    // New user — create account + generate recovery key
    const email = decoded.email ?? `${decoded.uid}@firebase.user`;
    const name = decoded.name ?? decoded.email?.split('@')[0] ?? 'User';
    const passwordHash = `firebase:${decoded.uid}`; // sentinel — never compared via bcrypt

    const salt = randomBytes(16);
    const encryptionSalt = salt.toString('base64');

    const dek = this.userKeyService.generateDek();
    const recoveryKey = dek.toString('base64');
    const recoveryKeyHash = this.hashRecoveryKey(recoveryKey);

    const newUser = await this.usersService.createUser(email, passwordHash, name, encryptionSalt);
    await this.usersService.setFirebaseUid(newUser!.id, decoded.uid);
    await this.usersService.updateRecoveryKeyHash(newUser!.id, recoveryKeyHash);
    await this.usersService.incrementKeyVersion(newUser!.id); // bump to 2
    await this.memoryBanksService.getOrCreateDefault(newUser!.id);
    await this.userKeyService.storeDek(newUser!.id, dek);

    this.logger.log(
      `Created local user ${newUser!.id} for Firebase UID ${decoded.uid} (recovery key generated)`,
    );
    const fullUser = await this.usersService.findById(newUser!.id);
    return { user: fullUser, recoveryKey, needsRecoveryKey: false };
  }
}
