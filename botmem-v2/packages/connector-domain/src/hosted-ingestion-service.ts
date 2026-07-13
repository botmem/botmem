import { ConnectorAccount } from './connector-account.js';
import { AccountNotFoundError } from './errors.js';
import { planIngestRevisions } from './ingest-revision.js';
import type {
  CloseSyncCommand,
  CommitSyncPageCommand,
  CommitSyncPageResult,
  HostedIngestionUnitOfWork,
  HostedIngestionUseCase,
  IngestionIdFactory,
  StartSyncCommand,
} from './ports.js';

export class HostedIngestionService implements HostedIngestionUseCase {
  public constructor(
    private readonly unitOfWork: HostedIngestionUnitOfWork,
    private readonly ids: IngestionIdFactory,
  ) {}

  public async startSync(command: StartSyncCommand) {
    const account = await this.loadAccount(command);
    const claim = account.claimSync(
      {
        id: command.syncId,
        startedAt: command.startedAt,
        leaseExpiresAt: command.leaseExpiresAt,
      },
      command.startedAt,
    );
    return this.unitOfWork.claimSync(claim);
  }

  public async commitPage(command: CommitSyncPageCommand): Promise<CommitSyncPageResult> {
    const account = await this.loadAccount(command);
    const revisions = planIngestRevisions(
      command.events,
      command.observedAt,
      () => this.ids.nextRevisionId(),
      () => this.ids.nextOutboxMessageId(),
    );
    const commit = account.commitPage({
      syncId: command.syncId,
      expectedCursorVersion: command.expectedCursorVersion,
      nextCursor: command.nextCursor,
      revisions,
      committedAt: command.observedAt,
    });
    return this.unitOfWork.commitPage(commit);
  }

  public async closeSync(command: CloseSyncCommand) {
    const account = await this.loadAccount(command);
    const close = account.closeSync(
      command.syncId,
      command.outcome,
      command.closedAt,
      command.reasonCode ?? null,
    );
    return this.unitOfWork.closeSync(close);
  }

  private async loadAccount(input: {
    readonly tenantId: StartSyncCommand['tenantId'];
    readonly accountId: StartSyncCommand['accountId'];
  }): Promise<ConnectorAccount> {
    const snapshot = await this.unitOfWork.loadAccount(input.tenantId, input.accountId);
    if (!snapshot) {
      throw new AccountNotFoundError();
    }
    return ConnectorAccount.rehydrate(snapshot);
  }
}
