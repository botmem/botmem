import type { Readable } from 'node:stream';
import type { AuthenticatedPrincipal } from '../identity/domain.js';
import {
  assertOwnerBrowserPrincipal,
  LifecycleExportNotReadyError,
  LifecycleInputError,
  type LifecycleJobView,
} from './domain.js';
import type {
  LifecycleApiRepositoryPort,
  LifecycleArtifactReaderPort,
  LifecycleClockPort,
  LifecycleIdPort,
} from './ports.js';

export interface WorkspaceLifecycleServiceOptions {
  readonly maxAttempts?: number;
}

export class WorkspaceLifecycleService {
  private readonly maxAttempts: number;

  constructor(
    private readonly repository: LifecycleApiRepositoryPort,
    private readonly artifacts: LifecycleArtifactReaderPort,
    private readonly ids: LifecycleIdPort,
    private readonly clock: LifecycleClockPort,
    options: WorkspaceLifecycleServiceOptions = {},
  ) {
    this.maxAttempts = options.maxAttempts ?? 8;
    if (this.maxAttempts < 1 || this.maxAttempts > 20) {
      throw new RangeError('lifecycle maximum attempts must be between 1 and 20');
    }
  }

  async list(principal: AuthenticatedPrincipal): Promise<readonly LifecycleJobView[]> {
    assertOwnerBrowserPrincipal(principal);
    return this.repository.list({ principal });
  }

  async requestExport(principal: AuthenticatedPrincipal): Promise<LifecycleJobView> {
    assertOwnerBrowserPrincipal(principal);
    return this.repository.requestExport({
      principal,
      jobId: this.ids.uuid(),
      requestedAt: new Date(this.clock.nowMs()).toISOString(),
      maxAttempts: this.maxAttempts,
    });
  }

  async requestDeletion(
    principal: AuthenticatedPrincipal,
    confirmation: string,
  ): Promise<LifecycleJobView> {
    assertOwnerBrowserPrincipal(principal);
    if (confirmation !== `DELETE ${principal.workspaceId}`) {
      throw new LifecycleInputError('typed confirmation did not match');
    }
    return this.repository.requestDeletion({
      principal,
      jobId: this.ids.uuid(),
      requestedAt: new Date(this.clock.nowMs()).toISOString(),
      maxAttempts: this.maxAttempts,
    });
  }

  async openExport(
    principal: AuthenticatedPrincipal,
    jobId: string,
  ): Promise<{ readonly body: Readable; readonly filename: string }> {
    assertOwnerBrowserPrincipal(principal);
    const artifactKey = await this.repository.consumeExportArtifactKey({
      principal,
      jobId,
      now: new Date(this.clock.nowMs()).toISOString(),
    });
    if (!artifactKey) throw new LifecycleExportNotReadyError();
    return {
      body: await this.artifacts.open(artifactKey),
      filename: `botmem-hosted-export-${principal.workspaceId}.ndjson`,
    };
  }
}
