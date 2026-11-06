/**
 * AtlasEngine MVP - Bootstrap Server
 *
 * Binds the HTTP listener first, then loads the full runtime module.
 * This keeps desktop cold start from waiting on the entire service/router
 * import graph before the backend can announce its port.
 */

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { Server as SocketIO } from 'socket.io';
import path from 'path';
import db from './src/db/index.js';

// Load environment variables.
// In desktop mode (ATLAS_DATA_DIR set by Tauri), load ONLY from the app data
// directory .env and avoid the workspace/server .env.
if (process.env.ATLAS_DATA_DIR) {
  dotenv.config({ path: path.join(process.env.ATLAS_DATA_DIR, '.env') });
} else {
  dotenv.config();
}

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const BIND_HOST =
  process.env.ATLAS_BIND_HOST ||
  (process.env.ATLAS_DESKTOP_MODE === 'true' ? '127.0.0.1' : undefined);
const SERVER_BOOT_STARTED_AT = Date.now();
const DEFAULT_CORS_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
];
const IS_DESKTOP = process.env.ATLAS_DESKTOP_MODE === 'true';
const LOCAL_DEV_ORIGIN_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1):\d+$/i;
const CORS_ORIGINS = IS_DESKTOP
  ? true
  : (process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean)
    : DEFAULT_CORS_ORIGINS);

function isAllowedCorsOrigin(origin) {
  if (!origin) return true;
  if (CORS_ORIGINS === true) return true;
  if (Array.isArray(CORS_ORIGINS) && CORS_ORIGINS.includes(origin)) return true;
  return NODE_ENV !== 'production' && LOCAL_DEV_ORIGIN_RE.test(origin);
}

function buildCorsOriginHandler() {
  if (CORS_ORIGINS === true) {
    return true;
  }

  return (origin, callback) => {
    if (isAllowedCorsOrigin(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error('Origin not allowed by CORS'));
  };
}

const app = express();
const httpServer = createServer(app);
const io = new SocketIO(httpServer, {
  cors: {
    origin: buildCorsOriginHandler(),
    methods: ['GET', 'POST'],
  },
});

globalThis.__ATLAS_BOOT_APP = app;
globalThis.__ATLAS_BOOT_HTTP_SERVER = httpServer;
globalThis.__ATLAS_BOOT_IO = io;
globalThis.__ATLAS_SERVER_BOOT_STARTED_AT = SERVER_BOOT_STARTED_AT;

let serverInitialized = false;
let runtimeModulePromise = null;
let runtimeHealthHandler = null;
let bootstrapRuntimeReadyPromise = null;

async function ensureBootstrapRuntimeReady() {
  if (!bootstrapRuntimeReadyPromise) {
    const startedAt = Date.now();
    bootstrapRuntimeReadyPromise = db.initialize()
      .then((ready) => {
        if (!ready) {
          throw new Error('Bootstrap runtime initialization failed');
        }
        console.log(`[startup] Bootstrap runtime ready in ${Date.now() - startedAt}ms`);
      })
      .catch((error) => {
        bootstrapRuntimeReadyPromise = null;
        throw error;
      });
  }

  await bootstrapRuntimeReadyPromise;
}

function createLazyRouter(importer, label) {
  let routerPromise = null;

  return async (req, res, next) => {
    try {
      await ensureBootstrapRuntimeReady();

      if (!routerPromise) {
        const importStartedAt = Date.now();
        routerPromise = importer()
          .then((module) => {
            console.log(`[startup] Bootstrap route ${label} loaded in ${Date.now() - importStartedAt}ms`);
            return module.default;
          });
      }

      const router = await routerPromise;
      return router(req, res, next);
    } catch (error) {
      return next(error);
    }
  };
}

async function loadRuntimeModule() {
  if (!runtimeModulePromise) {
    runtimeModulePromise = import('./server-runtime.js');
  }

  const runtimeModule = await runtimeModulePromise;
  if (typeof runtimeModule.handleRuntimeHealth === 'function') {
    runtimeHealthHandler = runtimeModule.handleRuntimeHealth;
  }
  return runtimeModule;
}

app.use(cors({
  origin: buildCorsOriginHandler(),
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  exposedHeaders: ['Content-Length', 'X-Request-Id'],
  maxAge: 86400,
}));

app.use(express.json({
  limit: '10mb',
  verify: (req, res, buf) => {
    if (req.url === '/api/github/webhook') {
      req.rawBody = buf;
    }
  }
}));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use((req, res, next) => {
  if (req.headers.authorization) {
    req.user = {
      id: '00000000-0000-0000-0000-000000000000',
      email: 'anonymous@atlasengine.local',
    };
  }
  next();
});

// Keep the first-run wizard and project import flow usable while the full
// runtime module is still importing in the background.
app.use('/api/settings', createLazyRouter(() => import('./src/routes/settings.js'), 'settings'));
app.use('/api/providers', createLazyRouter(() => import('./src/routes/providers.js'), 'providers'));
app.use('/api/claude', createLazyRouter(() => import('./src/routes/claude.js'), 'claude'));
app.use('/api/mcp', createLazyRouter(() => import('./src/routes/mcp.js'), 'mcp'));
app.use('/api/projects', createLazyRouter(() => import('./src/routes/projects.js'), 'projects'));
app.use('/api/github', createLazyRouter(() => import('./src/routes/github.js'), 'github'));

app.get('/health', async (req, res) => {
  if (!serverInitialized) {
    return res.status(503).json({
      status: 'starting',
      message: 'Server is initializing',
    });
  }

  if (runtimeHealthHandler) {
    return runtimeHealthHandler(req, res);
  }

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

async function listen() {
  const displayHost = BIND_HOST || 'localhost';

  await new Promise((resolve, reject) => {
    const onListening = () => {
      const address = httpServer.address();
      const resolvedPort = typeof address === 'object' && address ? address.port : PORT;

      console.log('');
      console.log('╔════════════════════════════════════════════════════════════╗');
      console.log('║                 AtlasEngine MVP Server                     ║');
      console.log('╚════════════════════════════════════════════════════════════╝');
      console.log('');
      console.log(`BACKEND_PORT=${resolvedPort}`);
      console.log(`[startup] Bootstrap listener ready in ${Date.now() - SERVER_BOOT_STARTED_AT}ms`);
      console.log(`🌐 Server running on: http://${displayHost}:${resolvedPort}`);
      console.log(`📝 Environment: ${NODE_ENV}`);
      console.log(`🔗 API Base: http://${displayHost}:${resolvedPort}/api`);
      console.log(`❤️  Health check: http://${displayHost}:${resolvedPort}/health`);
      console.log('');
      resolve();
    };

    httpServer.on('error', reject);

    if (BIND_HOST) {
      httpServer.listen(PORT, BIND_HOST, onListening);
    } else {
      httpServer.listen(PORT, onListening);
    }
  });
}

async function shutdown(signal) {
  console.log(`${signal} received, shutting down gracefully...`);

  try {
    if (runtimeModulePromise) {
      const runtimeModule = await runtimeModulePromise;
      if (typeof runtimeModule.shutdownRuntime === 'function') {
        await runtimeModule.shutdownRuntime();
      }
    }
  } catch (error) {
    console.error('Failed during runtime shutdown:', error);
  }

  await new Promise((resolve) => {
    httpServer.close(() => {
      console.log('HTTP server closed');
      resolve();
    });
  });

  process.exit(0);
}

async function start() {
  await listen();
  const bootstrapReady = ensureBootstrapRuntimeReady();

  const runtimeModule = await loadRuntimeModule();
  console.log(`[startup] Runtime module imported in ${Date.now() - SERVER_BOOT_STARTED_AT}ms`);

  await bootstrapReady;

  if (typeof runtimeModule.initializeRuntime === 'function') {
    await runtimeModule.initializeRuntime();
  }

  serverInitialized = true;

  console.log('Ready to accept requests! 🎉');
  console.log('');
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});

export { app, io };
