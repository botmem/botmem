// OTel must be loaded before ANY other imports to patch http/express/pg
import './tracing/otel';

import 'reflect-metadata';
import * as net from 'net';
import { IncomingMessage } from 'http';

// Disable Happy Eyeballs (autoSelectFamily) — Node 20+ tries IPv6 first,
// but on hosts without IPv6 the fallback to IPv4 can silently timeout instead
// of falling back. This breaks outbound HTTPS to googleapis.com etc.
net.setDefaultAutoSelectFamily(false);

import * as dotenv from 'dotenv';
import { join, resolve } from 'path';

// Resolve .env from the monorepo root, not the cwd (which may be apps/api/)
dotenv.config({ path: resolve(__dirname, '..', '..', '..', '.env') });

import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ExpressAdapter } from '@nestjs/platform-express';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from './app.module';
import { ConfigService } from './config/config.service';
import { readFileSync } from 'fs';
import type { Request, Response, NextFunction } from 'express';
import { PostHogExceptionFilter } from './analytics/posthog-exception.filter';
import { AnalyticsService } from './analytics/analytics.service';
import { PostHogLoggerService } from './analytics/posthog-logger.service';
import { TraceContext } from './tracing/trace.context';
import { HttpAdapterHost } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { createCorsOriginChecker } from './cors.util';

const logger = new Logger('Bootstrap');

async function bootstrap() {
  const express = (await import('express')).default;
  const server = express();
  const isDev = process.env.NODE_ENV !== 'production';
  let vite:
    | { middlewares: any; transformIndexHtml: (url: string, html: string) => Promise<string> }
    | undefined;

  // In dev mode, mount Vite BEFORE NestJS so it handles frontend assets + HMR
  if (isDev) {
    // @ts-expect-error — vite types don't resolve under API's moduleResolution setting
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
      vite!.middlewares(req, res, next);
    });
  }

  // Capture raw body for Stripe webhook signature verification
  server.use(
    '/api/billing/webhook',
    express.raw({ type: 'application/json' }),
    (req: Request, _res: Response, next: NextFunction) => {
      if (Buffer.isBuffer(req.body)) {
        (req as Request & { rawBody?: Buffer }).rawBody = req.body;
      }
      next();
    },
  );

  // Gzip/deflate compression for all responses (huge win for mobile Lighthouse)
  const compression = (await import('compression')).default;
  server.use(compression());

  // Proxy Firebase auth handler paths (/__/auth/*) so signInWithRedirect
  // stays on our domain when authDomain is set to our domain.
  const FIREBASE_HOST = (process.env.VITE_FIREBASE_PROJECT_ID || 'botmem-app') + '.firebaseapp.com';
  const https = await import('https');
  server.use('/__', (req: Request, res: Response) => {
    const proxyReq = https.request(
      {
        hostname: FIREBASE_HOST,
        path: '/__' + req.url,
        method: req.method,
        headers: { ...req.headers, host: FIREBASE_HOST },
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );
    proxyReq.on('error', () => res.status(502).send('Firebase proxy error'));
    req.pipe(proxyReq);
  });

  const helmet = (await import('helmet')).default;
  const cookieParser = (await import('cookie-parser')).default;
  const app = await NestFactory.create(AppModule, new ExpressAdapter(server), { rawBody: true });

  // Security headers (CASA 3.4.x, 14.3.2, 14.5.2)
  app.use(
    helmet({
      // CSP disabled: Cloudflare proxy strips single quotes from CSP values,
      // turning 'self' → self which blocks all resources. TODO: re-enable once
      // Cloudflare Transform Rule or DNS-only mode is configured.
      contentSecurityPolicy: false,
      hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    }),
  );

  // Permissions-Policy: restrict browser features (CASA finding #2)
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=()',
    );
    next();
  });

  app.use(cookieParser());
  app.enableShutdownHooks();

  // Strip trailing slashes from WebSocket upgrade URLs before WsAdapter processes them.
  // Caddy reverse proxy appends '/' to upgrade request paths (e.g. /events → /events/),
  // but the ws library does exact path matching, so /events/ doesn't match /events.
  app.getHttpServer().prependListener('upgrade', (req: IncomingMessage) => {
    if (req.url && req.url.length > 1 && req.url.endsWith('/')) {
      req.url = req.url.slice(0, -1);
    }
  });

  app.useWebSocketAdapter(new WsAdapter(app));
  app.setGlobalPrefix('api', {
    exclude: ['.well-known/{*path}', 'oauth/{*path}', 'mcp'],
  });

  const config = app.get(ConfigService);

  // Replace default logger with PostHog-forwarding logger
  const phLogger = new PostHogLoggerService();
  phLogger.init({
    apiKey: config.posthogApiKey,
    host: config.posthogHost,
    serviceName: config.posthogLogServiceName,
    minLevel: config.posthogLogMinLevel,
  });
  app.useLogger(phLogger);

  // Wire trace context into logger (logger is created before DI, so we bridge manually)
  const traceContext = app.get(TraceContext);
  phLogger.setTraceContext(traceContext);

  app.enableCors({
    origin: createCorsOriginChecker(config.frontendUrl),
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
    phLogger.shutdown().finally(() => {
      setTimeout(() => process.exit(0), 3000).unref();
    });
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

  // Production static file serving (replaces @nestjs/serve-static to avoid its
  // error handler converting throttle 429s and other API errors into 404s)
  if (!isDev) {
    const { existsSync } = await import('fs');
    const webDistPath = join(__dirname, '..', '..', 'web', 'dist');
    if (existsSync(webDistPath)) {
      const serveStatic = (await import('serve-static')).default;
      server.use(
        serveStatic(webDistPath, {
          maxAge: '1y',
          immutable: true,
          setHeaders: (res, path) => {
            if (path.endsWith('.html')) {
              res.setHeader('Cache-Control', 'no-cache');
            }
          },
        }),
      );
      // SPA catch-all: non-API GET requests fall through to a clean index.html
      // (without prerendered landing page content that causes React hydration errors)
      const spaPath = join(webDistPath, '_spa.html');
      const indexPath = existsSync(spaPath) ? spaPath : join(webDistPath, 'index.html');
      server.get('{*path}', (req: Request, res: Response, next: NextFunction) => {
        if (
          req.originalUrl.startsWith('/api') ||
          req.originalUrl.startsWith('/events') ||
          req.originalUrl.startsWith('/.well-known') ||
          (req.originalUrl.startsWith('/oauth') && !req.originalUrl.startsWith('/oauth/consent')) ||
          req.originalUrl.startsWith('/mcp')
        ) {
          return next();
        }
        res.setHeader('Cache-Control', 'no-cache');
        res.sendFile(indexPath);
      });
    }
  }

  // Swagger / OpenAPI docs — disabled in production (CASA 14.3.2)
  if (isDev) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Botmem API')
      .setDescription('Personal memory for AI agents')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
    const swaggerCss = readFileSync(join(__dirname, 'swagger-theme.css'), 'utf-8');
    SwaggerModule.setup('api/docs', app, swaggerDocument, {
      jsonDocumentUrl: 'api/docs/json',
      customSiteTitle: 'Botmem API Docs',
      customCss: swaggerCss,
      swaggerOptions: {
        docExpansion: 'list',
        filter: true,
        showRequestDuration: true,
        persistAuthorization: true,
      },
    });
  }

  const port = config.port;
  await app.listen(port);
  logger.log(`botmem running on http://localhost:${port}`);
}

bootstrap();
