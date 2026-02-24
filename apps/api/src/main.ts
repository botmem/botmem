import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from './app.module';
import { ConfigService } from './config/config.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  app.useWebSocketAdapter(new WsAdapter(app));
  app.setGlobalPrefix('api');
  app.enableCors();

  // Force-exit if graceful shutdown takes too long (e.g. BullMQ/Redis stalling)
  const forceExit = () => {
    console.log('Shutting down...');
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', forceExit);
  process.on('SIGINT', forceExit);

  const config = app.get(ConfigService);
  const port = config.port;
  await app.listen(port);
  console.log(`botmem API running on http://localhost:${port}`);
}

bootstrap();
