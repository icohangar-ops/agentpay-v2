// Prisma client singleton — single shared instance across the process.
// @ts-ignore Prisma generates the client at install time.
import { PrismaClient } from '@prisma/client';
import { env } from './env';

const globalForPrisma = globalThis as unknown as { __prisma?: PrismaClient };

export const db: PrismaClient =
  globalForPrisma.__prisma ??
  new PrismaClient({
    datasourceUrl: env.db.url,
    log: ['warn', 'error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.__prisma = db;
