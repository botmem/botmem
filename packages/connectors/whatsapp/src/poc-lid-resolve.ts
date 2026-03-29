/**
 * POC: Resolve WhatsApp LID JIDs to phone numbers using USyncQuery.
 *
 * Usage:
 *   npx tsx packages/connectors/whatsapp/src/poc-lid-resolve.ts <session-dir>
 *
 * This connects to an existing WA session, collects all LID-based chat JIDs
 * from recent history, and attempts to resolve them to phone numbers via
 * USyncQuery with ContactProtocol.
 */
import { makeWASocket, DisconnectReason } from '@whiskeysockets/baileys';
import { useMultiFileAuthState } from '@whiskeysockets/baileys';
import { USyncQuery, USyncUser } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { join } from 'path';
import { readFileSync, writeFileSync } from 'fs';

const sessionDir = process.argv[2];
if (!sessionDir) {
  console.error('Usage: npx tsx poc-lid-resolve.ts <session-dir>');
  process.exit(1);
}

function isLid(jid: string): boolean {
  return jid.includes('@lid');
}

function phoneFromJid(jid: string): string {
  return jid.replace(/[@:].*/g, '').replace('+', '');
}

async function main() {
  console.log(`[POC] Connecting with session: ${sessionDir}`);

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: ['Mac OS', 'Chrome', '10.15.7'],
    logger: {
      level: 'warn',
      info: () => {},
      debug: () => {},
      warn: console.warn,
      error: console.error,
      trace: () => {},
      fatal: console.error,
      child: () => ({
        level: 'warn',
        info: () => {},
        debug: () => {},
        warn: console.warn,
        error: console.error,
        trace: () => {},
        fatal: console.error,
        child: () => ({}) as any,
      }),
    } as any,
  });

  sock.ev.on('creds.update', saveCreds);

  // Wait for connection
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Connection timeout')), 30_000);
    sock.ev.on('connection.update', (update) => {
      if (update.connection === 'open') {
        clearTimeout(timeout);
        resolve();
      }
      if (update.connection === 'close') {
        const statusCode = (update.lastDisconnect?.error as Boom)?.output?.statusCode ?? 0;
        if (statusCode === DisconnectReason.restartRequired) {
          console.log('[POC] 515 restart — reconnecting...');
          return;
        }
        clearTimeout(timeout);
        reject(new Error(`Connection closed: ${statusCode}`));
      }
    });
  });

  console.log('[POC] Connected! JID:', sock.user?.id);

  // Step 1: Fetch all groups to find LID participants
  console.log('\n[POC] Fetching group participants...');
  const groups = await sock.groupFetchAllParticipating();
  const groupCount = Object.keys(groups).length;
  console.log(`[POC] Found ${groupCount} groups`);

  // Collect unique LID JIDs from group participants
  const lidJids = new Set<string>();
  for (const group of Object.values(groups)) {
    for (const p of group.participants) {
      if (isLid(p.id)) {
        lidJids.add(p.id);
      }
    }
    // Also check the group JID itself
    if (isLid(group.id)) {
      lidJids.add(group.id);
    }
  }

  // Also load identity maps if they exist
  try {
    const maps = JSON.parse(readFileSync(join(sessionDir, 'identity-maps.json'), 'utf-8'));
    const existingLidToPhone = new Map(Object.entries(maps.lidToPhone || {}));
    console.log(`[POC] Existing identity maps: ${existingLidToPhone.size} LID→phone`);
  } catch {
    console.log('[POC] No existing identity maps');
  }

  console.log(`[POC] Found ${lidJids.size} unique LID JIDs from groups`);

  // Step 2: Try resolving LIDs via USyncQuery with ContactProtocol
  console.log('\n[POC] === USyncQuery Resolution Test ===');

  const lidArray = [...lidJids].slice(0, 20); // Test with first 20
  const results: Array<{ lid: string; phone: string | null; exists: boolean }> = [];

  // Try batch query
  console.log(`[POC] Querying ${lidArray.length} LIDs via USyncQuery...`);
  try {
    const query = new USyncQuery().withContactProtocol();
    for (const lid of lidArray) {
      const lidNum = phoneFromJid(lid);
      query.withUser(new USyncUser().withLid(lidNum));
    }
    const result = await sock.executeUSyncQuery(query);
    console.log(`[POC] USyncQuery result:`, JSON.stringify(result, null, 2).substring(0, 2000));

    if (result?.list) {
      for (const entry of result.list) {
        console.log(
          `[POC]   LID result: id=${entry.id}, contact=${entry.contact}, keys=${Object.keys(entry).join(',')}`,
        );
        results.push({
          lid: entry.id || 'unknown',
          phone: entry.id && !isLid(entry.id) ? phoneFromJid(entry.id) : null,
          exists: !!entry.contact,
        });
      }
    }
  } catch (err) {
    console.error('[POC] USyncQuery batch failed:', err instanceof Error ? err.message : err);
  }

  // Step 3: Try individual queries for a few LIDs
  console.log('\n[POC] === Individual LID queries ===');
  for (const lid of lidArray.slice(0, 5)) {
    try {
      const query = new USyncQuery().withContactProtocol();
      query.withUser(new USyncUser().withLid(phoneFromJid(lid)));
      const result = await sock.executeUSyncQuery(query);
      const entry = result?.list?.[0];
      console.log(
        `[POC] LID ${lid} → id=${entry?.id}, contact=${entry?.contact}, keys=${entry ? Object.keys(entry).join(',') : 'none'}`,
      );

      // Also try withId directly
      const query2 = new USyncQuery().withContactProtocol();
      query2.withUser(new USyncUser().withId(lid));
      const result2 = await sock.executeUSyncQuery(query2);
      const entry2 = result2?.list?.[0];
      console.log(`[POC]   withId: id=${entry2?.id}, contact=${entry2?.contact}`);
    } catch (err) {
      console.log(`[POC] LID ${lid} failed:`, err instanceof Error ? err.message : err);
    }
  }

  // Step 4: Try onWhatsApp with a known phone to verify the API works
  console.log('\n[POC] === onWhatsApp verification ===');
  try {
    const waResult = await sock.onWhatsApp('+447873487293'); // Tewfik's number
    console.log('[POC] onWhatsApp(Tewfik):', JSON.stringify(waResult));
  } catch (err) {
    console.log('[POC] onWhatsApp failed:', err instanceof Error ? err.message : err);
  }

  // Step 5: Try reverse — get Tewfik's LID from his phone, then check if that LID appears in groups
  console.log('\n[POC] === Reverse lookup: phone → LID ===');
  try {
    const query = new USyncQuery().withContactProtocol();
    query.withUser(new USyncUser().withPhone('+447873487293'));
    const result = await sock.executeUSyncQuery(query);
    const entry = result?.list?.[0];
    console.log('[POC] Tewfik phone→LID query:', JSON.stringify(entry));

    if (entry?.id && isLid(entry.id)) {
      const tewfikLid = entry.id;
      console.log(`[POC] Tewfik LID: ${tewfikLid}`);
      console.log(`[POC] Is in our LID set: ${lidJids.has(tewfikLid)}`);
    }
  } catch (err) {
    console.log('[POC] Reverse lookup failed:', err instanceof Error ? err.message : err);
  }

  // Save results
  const output = {
    timestamp: new Date().toISOString(),
    totalLids: lidJids.size,
    testedLids: lidArray.length,
    results,
    groupCount,
  };
  const outPath = join(sessionDir, 'poc-lid-resolve-results.json');
  writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\n[POC] Results saved to ${outPath}`);

  // Cleanup
  sock.ws?.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('[POC] Fatal:', err);
  process.exit(1);
});
