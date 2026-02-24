import { execFile } from 'child_process';
import { promisify } from 'util';
import type { ConnectorDataEvent } from '@botmem/connector-sdk';

const execFileAsync = promisify(execFile);

export async function checkExporter(): Promise<boolean> {
  try {
    await execFileAsync('which', ['imessage-exporter']);
    return true;
  } catch {
    return false;
  }
}

export async function exportMessages(
  signal: AbortSignal,
  emit: (event: ConnectorDataEvent) => void,
): Promise<number> {
  const { stdout } = await execFileAsync('imessage-exporter', ['-f', 'json'], {
    maxBuffer: 100 * 1024 * 1024,
    signal,
  });

  const messages = JSON.parse(stdout);
  let processed = 0;

  for (const msg of messages) {
    if (signal.aborted) break;

    emit({
      sourceType: 'message',
      sourceId: msg.guid || `imsg-${msg.date}`,
      timestamp: msg.date ? new Date(msg.date).toISOString() : new Date().toISOString(),
      content: {
        text: msg.text || '',
        participants: [msg.sender, msg.recipient].filter(Boolean),
        metadata: {
          chatId: msg.chat_id,
          service: msg.service,
          isFromMe: msg.is_from_me,
        },
      },
    });
    processed++;
  }

  return processed;
}
