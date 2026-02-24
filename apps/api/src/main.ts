import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { join } from 'path';
import { AppModule } from './app.module';
import { ConfigService } from './config/config.service';

const isDev = process.env.NODE_ENV !== 'production';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useWebSocketAdapter(new WsAdapter(app));
  app.setGlobalPrefix('api');
  app.enableCors();

  if (isDev) {
    const { createServer } = await import('vite');
    const vite = await createServer({
      root: join(__dirname, '..', '..', 'web'),
      server: { middlewareMode: true, hmr: { path: '/__vite_hmr' } },
      appType: 'spa',
    });
    app.getHttpAdapter().getInstance().use(vite.middlewares);
  }

  const config = app.get(ConfigService);
  const port = config.port;
  await app.listen(port);
  console.log(`botmem running on http://localhost:${port}${isDev ? ' (dev)' : ''}`);
}

bootstrap();
