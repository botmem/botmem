import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PostHog } from 'posthog-node';
import { ConfigService } from '../config/config.service';

@Injectable()
export class AnalyticsService implements OnModuleDestroy {
  private client: PostHog | null = null;

  constructor(private config: ConfigService) {
    const apiKey = config.posthogApiKey;
    if (apiKey) {
      this.client = new PostHog(apiKey, { host: 'https://us.i.posthog.com' });
    }
  }

  capture(event: string, properties?: Record<string, unknown>): void {
    this.client?.capture({ distinctId: 'server', event, properties });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.shutdown();
  }
}
