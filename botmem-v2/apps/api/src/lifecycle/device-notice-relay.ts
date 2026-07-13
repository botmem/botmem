import type {
  DeviceDeletionDeliveryPort,
  DeviceDeletionNoticeRelayRepositoryPort,
  LifecycleClockPort,
  LifecycleTelemetryPort,
} from './ports.js';

export interface DeviceDeletionNoticeRelayOptions {
  readonly relayId: string;
  readonly leaseMs?: number;
  readonly pollIntervalMs?: number;
}

/** Runs inside the API replica, where the existing device presence relay lives. */
export class DeviceDeletionNoticeRelay {
  private readonly leaseMs: number;
  private readonly pollIntervalMs: number;

  constructor(
    private readonly notices: DeviceDeletionNoticeRelayRepositoryPort,
    private readonly delivery: DeviceDeletionDeliveryPort,
    private readonly clock: LifecycleClockPort,
    private readonly telemetry: LifecycleTelemetryPort,
    private readonly options: DeviceDeletionNoticeRelayOptions,
  ) {
    if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(options.relayId)) {
      throw new Error('device deletion relay ID is invalid');
    }
    this.leaseMs = options.leaseMs ?? 30_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    if (this.leaseMs < 5_000 || this.leaseMs > 120_000) {
      throw new RangeError('device deletion relay lease is invalid');
    }
    if (this.pollIntervalMs < 100 || this.pollIntervalMs > 60_000) {
      throw new RangeError('device deletion relay poll interval is invalid');
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const worked = await this.runOnce();
      if (!worked) await wait(this.pollIntervalMs, signal);
    }
  }

  async runOnce(): Promise<boolean> {
    const nowMs = this.clock.nowMs();
    const notice = await this.notices.claim({
      relayId: this.options.relayId,
      claimedAt: new Date(nowMs).toISOString(),
      leaseExpiresAt: new Date(nowMs + this.leaseMs).toISOString(),
    });
    if (!notice) return false;
    try {
      const state = await this.delivery.deliver(notice);
      const finished = await this.notices.finish({
        jobId: notice.jobId,
        deviceId: notice.deviceId,
        relayId: this.options.relayId,
        leaseToken: notice.leaseToken,
        state,
        attemptedAt: new Date(this.clock.nowMs()).toISOString(),
      });
      if (finished) {
        this.telemetry.event({
          event: state === 'delivered' ? 'local_delete_delivered' : 'local_delete_unreachable',
          jobId: notice.jobId,
          kind: 'deletion',
        });
      }
    } catch {
      const failedAtMs = this.clock.nowMs();
      const delayMs = Math.min(5 * 60_000, 5_000 * 2 ** Math.max(0, notice.attempts - 1));
      const state = await this.notices.fail({
        jobId: notice.jobId,
        deviceId: notice.deviceId,
        relayId: this.options.relayId,
        leaseToken: notice.leaseToken,
        failedAt: new Date(failedAtMs).toISOString(),
        retryAt: new Date(failedAtMs + delayMs).toISOString(),
      });
      if (state === 'unreachable') {
        this.telemetry.event({
          event: 'local_delete_unreachable',
          jobId: notice.jobId,
          kind: 'deletion',
        });
      }
    }
    return true;
  }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timeout = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done(): void {
      clearTimeout(timeout);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}
