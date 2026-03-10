import type { BotmemClient } from '../client.js';
import { formatVersion } from '../format.js';

export const versionHelp = `
  botmem version -- Show API build info and uptime

  USAGE
    botmem version [--json]
`.trim();

export async function runVersion(client: BotmemClient, json: boolean) {
  const data = await client.getVersion();

  if (json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(formatVersion(data));
  }
}
