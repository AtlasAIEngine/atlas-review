import { describe, expect, it } from 'vitest';
import { deriveProjectPreviewState } from '../previewStateService.js';

describe('deriveProjectPreviewState', () => {
  it('keeps dev preview on the proxy route when the server is already live', () => {
    const result = deriveProjectPreviewState({
      projectId: 'project-1',
      devServer: {
        running: true,
        status: 'running',
        requiresDevServer: true,
        projectType: 'next',
      },
      hasPreviewableRoot: true,
      hasActiveAiRun: true,
      hasStreamContent: true,
    });

    expect(result.state).toBe('dev_server_live');
    expect(result.currentPath).toBe('/preview-proxy/dev/project-1/');
    expect(result.canAutoStartDevServer).toBe(false);
  });

  it('exposes a dev-server-ready state once scaffold files exist', () => {
    const result = deriveProjectPreviewState({
      projectId: 'project-2',
      devServer: {
        running: false,
        status: 'stopped',
        requiresDevServer: true,
        projectType: 'vite',
      },
      hasPreviewableRoot: true,
      hasActiveAiRun: true,
      hasStreamContent: false,
    });

    expect(result.state).toBe('dev_server_ready');
    expect(result.currentPath).toBeNull();
    expect(result.canAutoStartDevServer).toBe(true);
    expect(result.canManualStartDevServer).toBe(true);
  });

  it('keeps static preview projects on the static route', () => {
    const result = deriveProjectPreviewState({
      projectId: 'project-3',
      devServer: {
        running: false,
        requiresDevServer: false,
      },
      hasPreviewableRoot: true,
      hasActiveAiRun: true,
      hasStreamContent: true,
    });

    expect(result.state).toBe('static_ready');
    expect(result.currentPath).toBe('/preview/project-3/');
  });

  it('stays in scaffolding until there is something previewable', () => {
    const result = deriveProjectPreviewState({
      projectId: 'project-4',
      devServer: {
        running: false,
        requiresDevServer: false,
      },
      hasPreviewableRoot: false,
      hasActiveAiRun: true,
      hasStreamContent: false,
    });

    expect(result.state).toBe('scaffolding');
    expect(result.currentPath).toBeNull();
  });

  it('allows manual restart from an error state while suppressing auto-start', () => {
    const result = deriveProjectPreviewState({
      projectId: 'project-5',
      devServer: {
        running: false,
        status: 'error',
        requiresDevServer: true,
        projectType: 'vite',
      },
      hasPreviewableRoot: true,
      hasActiveAiRun: false,
      hasStreamContent: false,
    });

    expect(result.state).toBe('dev_server_error');
    expect(result.canAutoStartDevServer).toBe(false);
    expect(result.canManualStartDevServer).toBe(true);
  });
});
