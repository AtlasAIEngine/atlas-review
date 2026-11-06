import fs from 'fs/promises';
import path from 'path';
import devServerService from './devServerService.js';

const PREVIEWABLE_ROOT_FILES = new Set([
  'index.html',
]);

const PREVIEWABLE_ROOT_DIRS = new Set([
  'app',
  'pages',
  'public',
  'src',
]);

export async function detectPreviewableRoot(projectPath) {
  if (!projectPath) {
    return false;
  }

  try {
    const entries = await fs.readdir(projectPath, { withFileTypes: true });
    return entries.some((entry) => {
      const normalizedName = String(entry.name || '').trim().toLowerCase();
      if (!normalizedName) return false;

      if (entry.isFile()) {
        return PREVIEWABLE_ROOT_FILES.has(normalizedName);
      }

      if (entry.isDirectory()) {
        return PREVIEWABLE_ROOT_DIRS.has(normalizedName);
      }

      return false;
    });
  } catch (error) {
    console.error(`Failed to inspect previewable root for ${projectPath}:`, error.message);
    return false;
  }
}

export function deriveProjectPreviewState({
  projectId,
  devServer = {},
  hasPreviewableRoot = false,
  hasActiveAiRun = false,
  hasStreamContent = false,
}) {
  const requiresDevServer = Boolean(devServer?.requiresDevServer);
  const isDevServerRunning = Boolean(devServer?.running);
  const devServerStatus = String(devServer?.status || '').toLowerCase();
  const hasActivity = hasActiveAiRun || hasStreamContent;

  let state = 'empty';
  let currentPath = null;

  if (isDevServerRunning) {
    state = 'dev_server_live';
    currentPath = `/preview-proxy/dev/${projectId}/`;
  } else if (requiresDevServer) {
    if (devServerStatus === 'starting') {
      state = 'starting_dev_server';
    } else if (devServerStatus === 'error') {
      state = 'dev_server_error';
    } else if (hasPreviewableRoot) {
      state = 'dev_server_ready';
    } else if (hasActivity) {
      state = 'scaffolding';
    }
  } else if (hasPreviewableRoot) {
    state = 'static_ready';
    currentPath = `/preview/${projectId}/`;
  } else if (hasActivity) {
    state = 'scaffolding';
  }

  const canAutoStartDevServer = (
    requiresDevServer
    && hasPreviewableRoot
    && !isDevServerRunning
    && devServerStatus !== 'starting'
    && devServerStatus !== 'error'
  );
  const canManualStartDevServer = (
    requiresDevServer
    && !isDevServerRunning
    && devServerStatus !== 'starting'
  );

  return {
    state,
    currentPath,
    requiresDevServer,
    hasPreviewableRoot,
    hasActiveAiRun,
    hasStreamContent,
    canAutoStartDevServer,
    canManualStartDevServer,
    devServer,
  };
}

class PreviewStateService {
  async getProjectPreviewState({
    projectId,
    projectPath,
    hasActiveAiRun = false,
    hasStreamContent = false,
  }) {
    const [devServer, hasPreviewableRoot] = await Promise.all([
      devServerService.getDevServerStatus(projectId, projectPath || null),
      detectPreviewableRoot(projectPath),
    ]);

    return deriveProjectPreviewState({
      projectId,
      devServer,
      hasPreviewableRoot,
      hasActiveAiRun,
      hasStreamContent,
    });
  }
}

const previewStateService = new PreviewStateService();

export default previewStateService;
