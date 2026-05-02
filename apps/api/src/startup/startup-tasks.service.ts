import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

@Injectable()
export class StartupTasksService implements OnApplicationBootstrap {
  private readonly logger = new Logger(StartupTasksService.name);

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.DRAIN_TYPESENSE_TO_PG_ON_STARTUP !== '1') return;

    const scriptPath = join(__dirname, '..', '..', 'scripts', 'drain-typesense-to-pg-search.js');
    this.logger.log('Running one-shot Typesense to PostgreSQL search drain before API listen');
    await runNodeScript(scriptPath);
    this.logger.log('One-shot Typesense to PostgreSQL search drain finished');
  }
}

function runNodeScript(scriptPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      env: process.env,
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${scriptPath} exited with code ${code ?? `signal ${signal}`}`));
    });
  });
}
