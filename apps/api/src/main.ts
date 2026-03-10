import 'reflect-metadata';
import * as dotenv from 'dotenv';
dotenv.config();

import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
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

const logger = new Logger('Bootstrap');

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
      server: { middlewareMode: true, allowedHosts: true },
      appType: 'custom',
    });

    // Vite handles HMR, static assets, module transforms — skip /api and /events
    server.use((req: Request, res: Response, next: NextFunction) => {
      if (
        req.url.startsWith('/api') ||
        req.url.startsWith('/events') ||
        req.url.startsWith('/.well-known') ||
        (req.url.startsWith('/oauth') && !req.url.startsWith('/oauth/consent')) ||
        req.url.startsWith('/mcp')
      ) {
        return next();
      }
      vite.middlewares(req, res, next);
    });
  }

  const cookieParser = (await import('cookie-parser')).default;
  const app = await NestFactory.create(AppModule, new ExpressAdapter(server), { rawBody: true });
  app.use(cookieParser());
  app.enableShutdownHooks();
  app.useWebSocketAdapter(new WsAdapter(app));
  app.setGlobalPrefix('api', {
    exclude: ['.well-known/(.*)', 'oauth/(.*)', 'mcp'],
  });

  const config = app.get(ConfigService);
  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      // Allow MCP requests from any origin (AI tools have varied origins)
      if (!origin) return callback(null, true);
      const allowed = config.frontendUrl.includes(',')
        ? config.frontendUrl.split(',').map((s) => s.trim())
        : [config.frontendUrl];
      if (allowed.includes(origin)) return callback(null, true);
      // Allow all origins for MCP/OAuth endpoints (stateless Bearer auth)
      callback(null, true);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id'],
    exposedHeaders: ['Mcp-Session-Id'],
  });

  // Global validation: reject invalid input, strip unknown properties
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Global exception filter: sends 5xx errors to PostHog
  const analyticsService = app.get(AnalyticsService);
  const httpAdapterHost = app.get(HttpAdapterHost);
  app.useGlobalFilters(new PostHogExceptionFilter(analyticsService, httpAdapterHost));

  // Graceful shutdown: close HTTP server immediately to release the port,
  // then force-exit if cleanup (BullMQ/Redis) stalls
  const httpServer = app.getHttpServer();
  const shutdown = () => {
    logger.log('Shutting down...');
    httpServer.close();
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // SPA fallback: serve index.html for non-API, non-asset GET requests (after NestJS routes)
  if (isDev && vite) {
    const webRoot = join(__dirname, '..', '..', 'web');
    server.use((req: Request, res: Response, next: NextFunction) => {
      if (
        req.method !== 'GET' ||
        req.originalUrl.startsWith('/api') ||
        req.originalUrl.startsWith('/events') ||
        req.originalUrl.startsWith('/.well-known') ||
        (req.originalUrl.startsWith('/oauth') && !req.originalUrl.startsWith('/oauth/consent')) ||
        req.originalUrl.startsWith('/mcp')
      ) {
        return next();
      }
      const template = readFileSync(join(webRoot, 'index.html'), 'utf-8');
      vite
        .transformIndexHtml(req.originalUrl, template)
        .then((html: string) => {
          res.status(200).set({ 'Content-Type': 'text/html' }).end(html);
        })
        .catch(next);
    });
  }

  const port = config.port;
  await app.listen(port);
  logger.log(`botmem running on http://localhost:${port}`);
}

bootstrap();
