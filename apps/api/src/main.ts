import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from './app.module';
import { ConfigService } from './config/config.service';
import { join } from 'path';
import { readFileSync } from 'fs';
import type { Request, Response, NextFunction } from 'express';
import { PostHogExceptionFilter } from './analytics/posthog-exception.filter';
import { AnalyticsService } from './analytics/analytics.service';
import { HttpAdapterHost } from '@nestjs/core';

async function bootstrap() {
  const express = (await import('express')).default;
  const server = express();
  const isDev = process.env.NODE_ENV !== 'production';
  let vite: any;

  // In dev mode, mount Vite BEFORE NestJS so it handles frontend assets + HMR
  if (isDev) {
    const { createServer: createViteServer } = await import('vite');
    const webRoot = join(__dirname, '..', '..', 'web');
    vite = await createViteServer({
      root: webRoot,
      server: { middlewareMode: true },
      appType: 'custom',
    });

    // Vite handles HMR, static assets, module transforms — skip /api and /events
    server.use((req: Request, res: Response, next: NextFunction) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/events')) {
        return next();
      }
      vite.middlewares(req, res, next);
    });
  }

  const app = await NestFactory.create(AppModule, new ExpressAdapter(server));
  app.enableShutdownHooks();
  app.useWebSocketAdapter(new WsAdapter(app));
  app.setGlobalPrefix('api');
  app.enableCors();

  // Global exception filter: sends 5xx errors to PostHog
  const analyticsService = app.get(AnalyticsService);
  const httpAdapterHost = app.get(HttpAdapterHost);
  app.useGlobalFilters(new PostHogExceptionFilter(analyticsService, httpAdapterHost));

  // Force-exit if graceful shutdown takes too long (e.g. BullMQ/Redis stalling)
  const forceExit = () => {
    console.log('Shutting down...');
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', forceExit);
  process.on('SIGINT', forceExit);

  // SPA fallback: serve index.html for non-API, non-asset GET requests (after NestJS routes)
  if (isDev && vite) {
    const webRoot = join(__dirname, '..', '..', 'web');
    server.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method !== 'GET' || req.originalUrl.startsWith('/api') || req.originalUrl.startsWith('/events')) {
        return next();
      }
      const template = readFileSync(join(webRoot, 'index.html'), 'utf-8');
      vite.transformIndexHtml(req.originalUrl, template).then((html: string) => {
        res.status(200).set({ 'Content-Type': 'text/html' }).end(html);
      }).catch(next);
    });
  }

  const config = app.get(ConfigService);
  const port = config.port;
  await app.listen(port);
  console.log(`botmem running on http://localhost:${port}`);
}

bootstrap();
