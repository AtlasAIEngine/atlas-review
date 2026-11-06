/**
 * Railway review-sync backend entrypoint.
 *
 * This intentionally runs a narrow HTTP surface instead of the full local Atlas
 * backend so Railway does not inherit Docker/CLI/filesystem assumptions that
 * only make sense on developer or desktop machines.
 */

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import db from './src/db/connection.js';
import reviewSyncRouter from './src/routes/reviewSync.js';
import authRouter from './src/routes/auth.js';
import adminRouter from './src/routes/admin.js';
import { ensurePostgresReviewSyncSchema } from './src/db/schema/reviewSyncSchema.js';
import { runMigrations } from './src/db/migrations/index.js';

dotenv.config();

const app = express();
const PORT = Number.parseInt(process.env.PORT || '8080', 10) || 8080;
const BIND_HOST = process.env.HOST || '0.0.0.0';

const defaultOrigins = [
  'tauri://localhost',
  'https://tauri.localhost',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];
const extraOrigins = String(process.env.CORS_ORIGINS || process.env.CORS_ORIGIN || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const allowedOrigins = new Set([...defaultOrigins, ...extraOrigins]);

app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error('Origin not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));

app.get('/health', async (_req, res) => {
  const dbHealth = await db.healthCheck();
  res.status(dbHealth.healthy ? 200 : 503).json({
    status: dbHealth.healthy ? 'ok' : 'error',
    service: 'atlas-review-sync',
    database: dbHealth.healthy ? 'connected' : 'disconnected',
    details: dbHealth,
  });
});

app.use('/api/review-sync', reviewSyncRouter);
app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);

async function start() {
  await runMigrations(db);
  await ensurePostgresReviewSyncSchema(db);

  const server = app.listen(PORT, BIND_HOST, () => {
    console.log(`Atlas review-sync backend listening on http://${BIND_HOST}:${PORT}`);
    console.log(`Health check: http://${BIND_HOST}:${PORT}/health`);
  });

  const shutdown = async (signal) => {
    console.log(`${signal} received, shutting down Railway review-sync backend...`);
    server.close(async () => {
      await db.close();
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((error) => {
  console.error('Failed to start Railway review-sync backend:', error);
  process.exit(1);
});

export default app;
