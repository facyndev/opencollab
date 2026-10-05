import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';

import { AppModule } from './app.module';

/** Same default as `protocol::DEFAULT_RELAY_ADDR` on the Rust side. */
const DEFAULT_RELAY_ADDR = '127.0.0.1:8787';

function parseAddr(): { host: string; port: number } {
  const raw = process.env.RELAY_ADDR ?? DEFAULT_RELAY_ADDR;
  const idx = raw.lastIndexOf(':');
  const port = idx >= 0 ? Number(raw.slice(idx + 1)) : NaN;
  if (idx < 0 || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`RELAY_ADDR inválida: ${raw}`);
  }
  return { host: raw.slice(0, idx), port };
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  // Raw `ws` frames (NOT socket.io): our wire is plain-text `Envelope` JSON.
  app.useWebSocketAdapter(new WsAdapter(app));
  const { host, port } = parseAddr();
  await app.listen(port, host);
}

void bootstrap();
