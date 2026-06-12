import { Injectable } from '@nestjs/common';

export type AccountFailureStatus = 'reconnect_required' | 'failed';

export interface ConnectorSyncFailurePolicy {
  accountStatus: AccountFailureStatus;
  fatal: boolean;
  recoverableRuntimeFailure: boolean;
}

@Injectable()
export class ConnectorSyncPolicyService {
  classifyFailure(connectorType: string, message: string): ConnectorSyncFailurePolicy {
    return {
      accountStatus: this.classifyAccountFailure(connectorType, message),
      fatal: this.isFatalSyncFailure(connectorType, message),
      recoverableRuntimeFailure: this.isRecoverableRuntimeFailure(connectorType, message),
    };
  }

  shouldIgnoreCursor(connectorType: string, scheduled: boolean | undefined): boolean {
    return connectorType === 'whatsapp' && !scheduled;
  }

  private classifyAccountFailure(connectorType: string, message: string): AccountFailureStatus {
    const msg = message.toLowerCase();
    if ((connectorType === 'apple' || connectorType === 'imessage') && this.isBridgeDown(msg)) {
      return 'reconnect_required';
    }
    if (
      msg.includes('invalid_grant') ||
      msg.includes('401') ||
      msg.includes('unauthorized') ||
      msg.includes('reconnect') ||
      msg.includes('re-scan qr') ||
      msg.includes('session expired') ||
      msg.includes('session files missing') ||
      msg.includes('no telegram session') ||
      msg.includes('please re-authenticate')
    ) {
      return 'reconnect_required';
    }
    if (connectorType === 'photos' && msg.includes('immich') && msg.includes('401')) {
      return 'reconnect_required';
    }
    return 'failed';
  }

  private isRecoverableRuntimeFailure(connectorType: string, message: string): boolean {
    if (connectorType !== 'whatsapp') return false;
    const msg = message.toLowerCase();
    return (
      msg.includes('connection lost during sync') ||
      msg.includes('connection closed during sync') ||
      msg.includes('connection lost during realtime sync') ||
      msg.includes('another whatsapp web session is active')
    );
  }

  private isFatalSyncFailure(connectorType: string, message: string): boolean {
    const msg = message.toLowerCase();
    return (
      this.classifyAccountFailure(connectorType, message) === 'reconnect_required' ||
      ((connectorType === 'apple' || connectorType === 'imessage') && this.isBridgeDown(msg))
    );
  }

  private isBridgeDown(message: string): boolean {
    return (
      message.includes('bridge not running') ||
      message.includes('bridge not connected') ||
      message.includes('bridge is not connected') ||
      message.includes('bridge disconnected') ||
      message.includes('bridge unreachable') ||
      message.includes('no bridge session') ||
      message.includes('tunnel is not connected') ||
      message.includes('tunnel is unavailable')
    );
  }
}
