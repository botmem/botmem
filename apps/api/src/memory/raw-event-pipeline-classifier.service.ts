import { Injectable } from '@nestjs/common';
import type { ConnectorDataEvent } from '@botmem/connector-sdk';
import type { rawEvents } from '../db/schema';

type LoadedRawEvent = typeof rawEvents.$inferSelect;

export type RawEventPipelineKind =
  | 'whatsapp_group_identity'
  | 'whatsapp_contact_identity'
  | 'gmail_contact_identity'
  | 'skip_contact'
  | 'memory';

@Injectable()
export class RawEventPipelineClassifier {
  classify(rawEvent: LoadedRawEvent, event: ConnectorDataEvent): RawEventPipelineKind {
    if (this.isWhatsAppGroupIdentity(rawEvent, event)) return 'whatsapp_group_identity';
    if (this.isWhatsAppContactIdentity(rawEvent, event)) return 'whatsapp_contact_identity';
    if (rawEvent.connectorType === 'gmail' && (event.sourceType as string) === 'contact') {
      return 'gmail_contact_identity';
    }
    if (this.shouldSkipContactLikeEvent(rawEvent, event)) return 'skip_contact';
    return 'memory';
  }

  private isWhatsAppGroupIdentity(rawEvent: LoadedRawEvent, event: ConnectorDataEvent): boolean {
    return (
      rawEvent.connectorType === 'whatsapp' &&
      (rawEvent.sourceId.startsWith('wa-group:') || event.sourceId.startsWith('wa-group:'))
    );
  }

  private isWhatsAppContactIdentity(rawEvent: LoadedRawEvent, event: ConnectorDataEvent): boolean {
    return (
      rawEvent.connectorType === 'whatsapp' &&
      (rawEvent.sourceId.startsWith('wa-contact:') || event.sourceId.startsWith('wa-contact:'))
    );
  }

  private shouldSkipContactLikeEvent(rawEvent: LoadedRawEvent, event: ConnectorDataEvent): boolean {
    const metadata = event.content?.metadata as Record<string, unknown> | undefined;
    return (
      ((event.sourceType as string) === 'contact' && rawEvent.connectorType !== 'gmail') ||
      (event.sourceType as string) === 'group' ||
      (rawEvent.connectorType === 'whatsapp' &&
        (rawEvent.sourceId.startsWith('wa-contact:') ||
          rawEvent.sourceId.startsWith('wa-group:') ||
          event.sourceId.startsWith('wa-contact:') ||
          event.sourceId.startsWith('wa-group:') ||
          metadata?.type === 'contact')) ||
      (rawEvent.connectorType === 'telegram' && event.sourceId.startsWith('telegram:contact:'))
    );
  }
}
