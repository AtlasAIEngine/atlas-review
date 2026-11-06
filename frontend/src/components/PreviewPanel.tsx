/**
 * Preview Panel Component
 * Displays live app preview with dev server and Docker preview support
 */

import { useState, useEffect, useRef, useMemo, useCallback, forwardRef, useImperativeHandle } from 'react';
import toast from '@/lib/toast';
import { devServerApi, projectApi, type DevServer, type ProjectPreviewState, getApiBaseUrl } from '@/services/api';
import type { UiEditPayload, UiSelection, TestCase, StepResult, TestResult, RecordedAction } from '@/types';
import { buildPreviewRouteUrl } from '@/utils/previewNavigation';
import { openExternal } from '@/utils/openExternal';

// Exposed methods for parent component
export interface PreviewPanelHandle {
  isIframeReady: () => boolean;
  runTest: (test: TestCase) => void;
  stopTest: () => void;
  validateSelector: (selector: string) => void;
  startRecording: () => void;
  stopRecording: () => void;
  startScreenshot: () => void;
  cancelScreenshot: () => void;
}

interface UiEditEvent {
  id: number;
  type: 'apply' | 'reset';
  payload?: UiEditPayload;
}

interface PreviewPanelProps {
  projectId: string;
  isEngaged?: boolean;
  refreshKey?: number; // Increment this to trigger iframe reload
  isSelectingUi?: boolean;
  onUiSelection?: (selection: UiSelection) => void;
  uiEditEvent?: UiEditEvent | null;
  uiSelection?: UiSelection | null;
  uiEditsActive?: boolean;
  // Test state from parent
  isRunningTest?: boolean;
  pickingElementForStep?: number | null;
  // Test callbacks to parent
  onTestStepResult?: (result: StepResult) => void;
  onTestComplete?: (result: TestResult) => void;
  onSelectorValidation?: (validation: { matches: boolean; count: number }) => void;
  onElementPicked?: (selector: string) => void;
  // Recording state and callbacks
  isRecording?: boolean;
  onRecordedAction?: (action: RecordedAction) => void;
  // Screenshot capture
  isCapturingScreenshot?: boolean;
  onScreenshotCaptured?: (dataUrl: string) => void;
  // System chat message callback (e.g., Supabase placeholder notification)
  onSystemChatMessage?: (message: { content: string; tone?: 'success' | 'error' | 'warning' }) => void;
}

const ATLAS_UI_SELECTION_VERSION = '20260323-foreign-object';

const PreviewPanel = forwardRef<PreviewPanelHandle, PreviewPanelProps>(({
  projectId,
  isEngaged = false,
  refreshKey,
  isSelectingUi,
  onUiSelection,
  uiEditEvent,
  // uiSelection and uiEditsActive no longer needed for URL logic since proxy is always used
  isRunningTest = false,
  pickingElementForStep = null,
  onTestStepResult,
  onTestComplete,
  onSelectorValidation,
  onElementPicked,
  isRecording = false,
  onRecordedAction,
  isCapturingScreenshot = false,
  onScreenshotCaptured,
  onSystemChatMessage,
}, ref) => {
  const [previewState, setPreviewState] = useState<ProjectPreviewState | null>(null);
  const [isStartingDevServer, setIsStartingDevServer] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [currentUrl, setCurrentUrl] = useState('');
  const [iframeReloadKey, setIframeReloadKey] = useState(0);
  const [iframeReady, setIframeReady] = useState(false);
  const [testRunnerReady, setTestRunnerReady] = useState(false);
  const [recorderReady, setRecorderReady] = useState(false);
  const [uiSelectionReady, setUiSelectionReady] = useState(false);
  const [uiSelectionVersion, setUiSelectionVersion] = useState<string | null>(null);
  const supabasePlaceholderNotifiedRef = useRef(false);
  const devServerStartingRef = useRef(false); // guard against concurrent start requests
  const autoStartRetryTimerRef = useRef<number | null>(null);
  const autoStartRetryCountRef = useRef(0);
  const autoStartSuppressedUntilRefreshKeyRef = useRef(-1);
  const autoStartCooldownUntilRef = useRef(0);
  const pendingIframeReloadTimerRef = useRef<number | null>(null);
  const pendingPreviewSyncRef = useRef(false);
  const lastHandledRefreshKeyRef = useRef(0);
  const backendBaseUrl = useMemo(() => {
    return getApiBaseUrl().replace(/\/api$/, '');
  }, []);
  const devServer = previewState?.devServer ?? null;
  const hasActiveAiRun = previewState?.hasActiveAiRun ?? false;
  const previewStateName = previewState?.state ?? 'empty';
  const isPreviewLaunching = isStartingDevServer || previewStateName === 'starting_dev_server';

  const getCurrentRefreshGeneration = () => (
    typeof refreshKey === 'number' && Number.isFinite(refreshKey)
      ? refreshKey
      : lastHandledRefreshKeyRef.current
  );

  const suppressAutoStart = (untilRefreshKey = getCurrentRefreshGeneration()) => {
    autoStartSuppressedUntilRefreshKeyRef.current = untilRefreshKey;
  };

  const clearAutoStartSuppression = () => {
    autoStartSuppressedUntilRefreshKeyRef.current = -1;
  };

  const clearAutoStartCooldown = () => {
    autoStartCooldownUntilRef.current = 0;
  };

  const isAutoStartSuppressed = (candidateRefreshKey = getCurrentRefreshGeneration()) => (
    candidateRefreshKey <= autoStartSuppressedUntilRefreshKeyRef.current
  );

  const clearAutoStartRetry = () => {
    if (autoStartRetryTimerRef.current !== null) {
      window.clearTimeout(autoStartRetryTimerRef.current);
      autoStartRetryTimerRef.current = null;
    }
    autoStartRetryCountRef.current = 0;
  };

  const clearPendingIframeReload = () => {
    if (pendingIframeReloadTimerRef.current !== null) {
      window.clearTimeout(pendingIframeReloadTimerRef.current);
      pendingIframeReloadTimerRef.current = null;
    }
  };

  const scheduleIframeReload = (delayMs = 1200) => {
    clearPendingIframeReload();
    pendingIframeReloadTimerRef.current = window.setTimeout(() => {
      pendingIframeReloadTimerRef.current = null;
      setIframeReloadKey((prev) => prev + 1);
    }, delayMs);
  };

  const getErrorMessage = (error: any): string => {
    const serverMsg = error?.response?.data?.error
      || error?.response?.data?.message
      || error?.response?.data?.details;
    if (typeof serverMsg === 'string' && serverMsg.trim()) {
      return serverMsg.trim();
    }
    return error?.message || 'Unknown error';
  };

  // Expose methods to parent via ref
  useImperativeHandle(ref, () => ({
    // Test runner is always injected now, so we wait for testRunnerReady
    // which implies the iframe is also loaded
    isIframeReady: () => testRunnerReady,
    runTest: (test: TestCase) => {
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'atlas-test-run', test },
        '*'
      );
    },
    stopTest: () => {
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'atlas-test-stop' },
        '*'
      );
    },
    validateSelector: (selector: string) => {
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'atlas-test-validate-selector', selector },
        '*'
      );
    },
    startRecording: () => {
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'atlas-record-start' },
        '*'
      );
    },
    stopRecording: () => {
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'atlas-record-stop' },
        '*'
      );
    },
    startScreenshot: () => {
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'atlas-screenshot-start' },
        '*'
      );
    },
    cancelScreenshot: () => {
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'atlas-screenshot-cancel' },
        '*'
      );
    },
  }), [testRunnerReady, recorderReady]);

  // Create a display URL that strips internal query parameters
  const displayUrl = useMemo(() => {
    if (!currentUrl) return '';
    try {
      const url = new URL(currentUrl);
      // Remove internal Atlas query params
      url.searchParams.delete('atlasTest');
      url.searchParams.delete('atlasSelect');
      return url.toString();
    } catch {
      // If URL parsing fails, just strip query string entirely as fallback
      return currentUrl.split('?')[0];
    }
  }, [currentUrl]);

  const loadPreviewState = useCallback(async () => {
    const response = await projectApi.getPreviewState(projectId);
    setPreviewState(response.preview);
    return response.preview;
  }, [projectId]);

  useEffect(() => {
    supabasePlaceholderNotifiedRef.current = false;
    clearAutoStartRetry();
    clearPendingIframeReload();
    clearAutoStartSuppression();
    clearAutoStartCooldown();
    pendingPreviewSyncRef.current = false;
    lastHandledRefreshKeyRef.current = 0;
    setPreviewState(null);
    setCurrentUrl('');
    setIframeReady(false);
    setTestRunnerReady(false);
    setRecorderReady(false);
    setUiSelectionReady(false);
    setUiSelectionVersion(null);

    if (!isEngaged) {
      return;
    }

    let cancelled = false;
    let intervalId: number | null = null;

    const syncPreviewState = async () => {
      try {
        await loadPreviewState();
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to load preview state:', error);
        }
      }
    };

    void syncPreviewState();
    intervalId = window.setInterval(() => {
      void syncPreviewState();
    }, 2000);

    return () => {
      cancelled = true;
      if (intervalId !== null) {
        window.clearInterval(intervalId);
      }
    };
  }, [isEngaged, loadPreviewState, projectId]);

  useEffect(() => () => {
    clearAutoStartRetry();
    clearPendingIframeReload();
    clearAutoStartCooldown();
  }, []);

  useEffect(() => {
    if (previewState?.devServer?.running) {
      notifySupabasePlaceholder(previewState.devServer);
    }
  }, [previewState, onSystemChatMessage]);

  // Update current URL when the backend preview target changes.
  // For dev server previews, verify the URL is reachable before showing it
  // to avoid displaying raw error pages from half-started servers.
  useEffect(() => {
    let cancelled = false;
    let newUrl = '';
    const currentPath = previewState?.currentPath || '';
    if (currentPath) {
      newUrl = `${backendBaseUrl}${currentPath}`;
    }

    if (newUrl === currentUrl) return;

    if (!newUrl) {
      // Clearing the URL — no health check needed
      setCurrentUrl('');
      setIframeReady(false);
      setTestRunnerReady(false);
      setRecorderReady(false);
      setUiSelectionReady(false);
      setUiSelectionVersion(null);
      return;
    }

    // Health-check: verify the preview URL is reachable before loading it
    const verifyAndSet = async () => {
      const delays = [0, 500, 1000, 2000, 3000];
      for (let i = 0; i < delays.length; i++) {
        if (cancelled) return;
        if (i > 0) await new Promise(r => setTimeout(r, delays[i]));
        if (cancelled) return;
        try {
          await fetch(newUrl, { method: 'HEAD', mode: 'no-cors' });
          // mode: 'no-cors' returns opaque response (status 0), which is fine — it means the server responded
          if (cancelled) return;
          console.log(`Preview health check passed (attempt ${i + 1}), loading:`, newUrl);
          setCurrentUrl(newUrl);
          setIframeReady(false);
          setTestRunnerReady(false);
          setRecorderReady(false);
          setUiSelectionReady(false);
          setUiSelectionVersion(null);
          return;
        } catch {
          console.log(`Preview health check attempt ${i + 1}/${delays.length} failed, retrying...`);
        }
      }
      // All retries exhausted — set URL anyway as fallback
      if (!cancelled) {
        console.log('Preview health check exhausted retries, loading URL anyway:', newUrl);
        setCurrentUrl(newUrl);
        setIframeReady(false);
        setTestRunnerReady(false);
        setRecorderReady(false);
        setUiSelectionReady(false);
        setUiSelectionVersion(null);
      }
    };

    void verifyAndSet();
    return () => { cancelled = true; };
  }, [
    devServer,
    previewState,
    backendBaseUrl,
    currentUrl,
  ]);

  // Handle messages from iframe (UI selection and test results)
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) {
        return;
      }
      const data = event.data as { type?: string; payload?: UiSelection; [key: string]: any };

      // UI selection messages
      if (data?.type === 'atlas-ui-select' && data.payload) {
        console.log('[PreviewPanel] Received UI selection, pickingElementForStep:', pickingElementForStep);
        // Check if we're picking element for a test step
        if (pickingElementForStep !== null) {
          // Use the selector from the selection
          const selector = data.payload.selector || '';
          console.log('[PreviewPanel] Element picked, selector:', selector);
          onElementPicked?.(selector);
        } else {
          onUiSelection?.(data.payload);
        }
      }

      if (data?.type === 'atlas-ui-select-ready') {
        setUiSelectionReady(true);
        setUiSelectionVersion(typeof data.version === 'string' ? data.version : null);
      }

      // Test runner ready
      if (data?.type === 'atlas-test-ready') {
        console.log('Test runner ready in iframe');
        setIframeReady(true);
        setTestRunnerReady(true);
      }

      // Test step result
      if (data?.type === 'atlas-test-step-result') {
        const result: StepResult = {
          stepIndex: data.stepIndex,
          status: data.status,
          actual: data.actual,
          error: data.error,
          screenshotData: data.screenshotData,
        };
        onTestStepResult?.(result);
      }

      // Test complete
      if (data?.type === 'atlas-test-complete' && data.result) {
        const result = data.result as TestResult;
        onTestComplete?.(result);
      }

      // Selector validation result
      if (data?.type === 'atlas-test-selector-validation') {
        onSelectorValidation?.({
          matches: data.matches,
          count: data.count,
        });
      }

      // Recorder ready
      if (data?.type === 'atlas-recorder-ready') {
        console.log('Recorder ready in iframe');
        setRecorderReady(true);
      }

      // Recorded action from recorder
      if (data?.type === 'atlas-record-action') {
        const action: RecordedAction = {
          action: data.action,
          selector: data.selector,
          value: data.value,
          elementInfo: data.elementInfo,
          timestamp: data.timestamp,
        };
        onRecordedAction?.(action);
      }

      // Screenshot captured
      if (data?.type === 'atlas-screenshot-captured' && data.dataUrl) {
        console.log('[PreviewPanel] Screenshot captured:', data.width, 'x', data.height);
        onScreenshotCaptured?.(data.dataUrl);
      }

      // Screenshot error — clear capture mode so the UI doesn't get stuck
      if (data?.type === 'atlas-screenshot-error') {
        console.error('[PreviewPanel] Screenshot error:', data.error);
        onScreenshotCaptured?.(''); // empty string signals error to parent
      }
    };

    window.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, [onUiSelection, pickingElementForStep, onTestStepResult, onTestComplete, onSelectorValidation, onElementPicked, onRecordedAction, onScreenshotCaptured]);

  const sendSelectionToggle = (enabled: boolean) => {
    iframeRef.current?.contentWindow?.postMessage(
      { type: 'atlas-ui-select-toggle', enabled },
      '*'
    );
  };

  useEffect(() => {
    if (!iframeReady) return;
    const shouldEnableSelection = !!isSelectingUi || pickingElementForStep !== null;
    sendSelectionToggle(shouldEnableSelection);
  }, [iframeReady, isSelectingUi, pickingElementForStep]);

  useEffect(() => {
    if (!iframeReady) return;
    if (isCapturingScreenshot) {
      if (!uiSelectionReady || uiSelectionVersion !== ATLAS_UI_SELECTION_VERSION) {
        iframeRef.current?.contentWindow?.postMessage({ type: 'atlas-ui-version-request' }, '*');
        return;
      }
      iframeRef.current?.contentWindow?.postMessage({ type: 'atlas-screenshot-start' }, '*');
    } else {
      iframeRef.current?.contentWindow?.postMessage({ type: 'atlas-screenshot-cancel' }, '*');
    }
  }, [iframeReady, isCapturingScreenshot, uiSelectionReady, uiSelectionVersion]);

  useEffect(() => {
    if (!uiEditEvent || !iframeReady) return;
    if (uiEditEvent.type === 'apply' && uiEditEvent.payload) {
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'atlas-ui-edit', payload: uiEditEvent.payload },
        '*'
      );
    }
    if (uiEditEvent.type === 'reset') {
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'atlas-ui-edit-reset' },
        '*'
      );
    }
  }, [uiEditEvent, iframeReady]);

  // Reload iframe when currentUrl changes
  useEffect(() => {
    if (iframeRef.current && currentUrl) {
      console.log('Updating iframe to:', currentUrl);
      const iframe = iframeRef.current;
      // Force a complete reload by setting to blank first
      setUiSelectionReady(false);
      setUiSelectionVersion(null);
      iframe.src = 'about:blank';
      // Then set to the actual URL after a brief delay
      setTimeout(() => {
        if (iframe && currentUrl) {
          iframe.src = currentUrl;
          console.log('Preview iframe loaded:', currentUrl);
        }
      }, 50);
    }
  }, [currentUrl]);

  // Navigate preview iframe to a specific route when requested from chat
  useEffect(() => {
    const handleRouteNav = (e: Event) => {
      const rawRoute = (e as CustomEvent).detail?.route;
      if (!rawRoute) return;

      const nextUrl = buildPreviewRouteUrl({
        rawRoute,
        backendBaseUrl,
        projectId,
        devServerRunning: Boolean(devServer && devServer.running),
        hasDevServerProject: Boolean(previewState?.requiresDevServer),
        currentUrl,
      });

      if (nextUrl) {
        setCurrentUrl(nextUrl);
      }
    };
    window.addEventListener('atlas-navigate-preview-route', handleRouteNav);
    return () => window.removeEventListener('atlas-navigate-preview-route', handleRouteNav);
  }, [backendBaseUrl, currentUrl, devServer, previewState, projectId]);

  // File-change pulses only ask the backend for the latest lifecycle state.
  // The iframe only remounts when the backend preview target changes or when
  // a static preview flushes after the run settles.
  const syncPreviewAfterChanges = async (refreshVersion: number) => {
      console.log(`File change detected (refreshKey: ${refreshVersion}), syncing preview lifecycle...`);
      try {
        const nextState = await loadPreviewState();

        // While AI is actively running, defer all preview actions.
        // This prevents premature renders of half-built projects.
        if (nextState.hasActiveAiRun) {
          console.log('AI run active — deferring preview sync until run completes');
          pendingPreviewSyncRef.current = true;
          lastHandledRefreshKeyRef.current = refreshVersion;
          return;
        }

        if (nextState.state === 'dev_server_live') {
          // Dev server is already running — just reload the iframe
          scheduleIframeReload(500);
          pendingPreviewSyncRef.current = false;
        } else if (nextState.canAutoStartDevServer) {
          if (isAutoStartSuppressed(refreshVersion)) {
            console.log('Auto-start is cooling down after repeated failure, skipping file-change start');
            pendingPreviewSyncRef.current = true;
          } else if (devServerStartingRef.current) {
            console.log('Dev server start already in flight, skipping file-change auto-start');
          } else {
            console.log('Preview lifecycle reports dev server is ready, auto-starting...');
            const started = await handleStartDevServer({
              showErrorToast: false,
              maxAttempts: 6,
              retryDelays: [2000, 3000, 5000, 7000, 10000],
              source: 'auto',
            });
            pendingPreviewSyncRef.current = !started;
          }
        } else if (nextState.state === 'static_ready') {
          scheduleIframeReload(250);
          pendingPreviewSyncRef.current = false;
        } else {
          pendingPreviewSyncRef.current = false;
        }
      } catch (err) {
        console.error('Failed to sync preview state on file change:', err);
      }
      lastHandledRefreshKeyRef.current = refreshVersion;
  };

  useEffect(() => {
    if (!isEngaged) return;
    if (refreshKey === undefined || refreshKey <= 0) return;
    if (refreshKey <= lastHandledRefreshKeyRef.current) return;

    void syncPreviewAfterChanges(refreshKey);
  }, [isEngaged, refreshKey, projectId, loadPreviewState]);

  useEffect(() => {
    if (!isEngaged) return;
    if (!pendingPreviewSyncRef.current) return;
    if (hasActiveAiRun) return;
    if (previewState?.state === 'static_ready') {
      scheduleIframeReload(250);
    } else if (previewState?.canAutoStartDevServer && !devServerStartingRef.current && !isAutoStartSuppressed()) {
      void handleStartDevServer({
        showErrorToast: false,
        maxAttempts: 6,
        retryDelays: [2000, 3000, 5000, 7000, 10000],
        source: 'auto',
      });
    }
    pendingPreviewSyncRef.current = false;
  }, [hasActiveAiRun, isEngaged, previewState]);

  const notifySupabasePlaceholder = (devServerResult: DevServer) => {
    if (devServerResult.supabasePlaceholder?.injected && onSystemChatMessage && !supabasePlaceholderNotifiedRef.current) {
      supabasePlaceholderNotifiedRef.current = true;
      const keys = devServerResult.supabasePlaceholder.missingKeys;
      const keyList = keys.map(k => `\`${k}\``).join(', ');
      onSystemChatMessage({
        content: [
          '**⚠️ Supabase: Placeholder Keys Injected**',
          '',
          'Your app uses Supabase, but no Supabase project is linked yet. To prevent a blank screen, placeholder values were injected for:',
          '',
          ...keys.map(k => `- \`${k}\``),
          '',
          'Your app will load, but **database operations will not work** until you connect a real Supabase project.',
          '',
          '**To fix this:**',
          '1. Open the **Settings** tab (in the top navigation bar)',
          '2. Select **Supabase** in the sidebar',
          '3. Connect your Supabase account with a Personal Access Token',
          '4. Link a Supabase project to this app',
          '',
          `Once linked, restart the dev server and the real keys (${keyList}) will be injected automatically.`,
        ].join('\n'),
        tone: 'warning',
      });
    }
  };

  const handleStartDevServer = async (options?: {
    showErrorToast?: boolean;
    maxAttempts?: number;
    retryDelays?: number[];
    source?: 'auto' | 'manual';
  }) => {
    const showErrorToast = options?.showErrorToast ?? true;
    const maxAttempts = options?.maxAttempts ?? 4;
    const retryDelays = options?.retryDelays ?? [2000, 3000, 4000];
    const source = options?.source ?? 'manual';

    clearAutoStartRetry();
    if (source === 'manual') {
      clearAutoStartSuppression();
      clearAutoStartCooldown();
    }
    devServerStartingRef.current = true;
    setIsStartingDevServer(true);

    let nonRetryableFailure = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const startResponse = await devServerApi.start(projectId);

        // Success — update state
        clearAutoStartSuppression();
        clearAutoStartCooldown();
        notifySupabasePlaceholder(startResponse.devServer);
        await loadPreviewState();
        toast.success(`Dev server started on port ${startResponse.devServer.port}`);
        autoStartRetryCountRef.current = 0;

        devServerStartingRef.current = false;
        setIsStartingDevServer(false);
        return true;
      } catch (error: any) {
        const msg = getErrorMessage(error);
        console.warn(`Dev server start attempt ${attempt}/${maxAttempts} failed:`, msg);
        if (source === 'auto') {
          autoStartCooldownUntilRef.current = Date.now() + 12000;
        }

        // Non-retryable errors — fail immediately
        if (msg.includes('Not a recognized dev server project')) {
          nonRetryableFailure = true;
          if (source === 'auto') {
            suppressAutoStart();
          }
          if (showErrorToast) toast.error(msg);
          break;
        }

        // Last attempt — show error
        if (attempt === maxAttempts) {
          if (source === 'auto') {
            suppressAutoStart();
          }
          if (showErrorToast) {
            toast.error(`Failed to start dev server: ${msg}`);
          }
          break;
        }

        // Wait before retrying (progressive backoff)
        await new Promise(r => setTimeout(r, retryDelays[attempt - 1] || retryDelays[retryDelays.length - 1] || 4000));
      }
    }

    if (
      !showErrorToast
      && !nonRetryableFailure
      && autoStartRetryTimerRef.current === null
      && autoStartRetryCountRef.current < 4
      && source === 'auto'
    ) {
      autoStartRetryCountRef.current += 1;
      // Keep trying in the background for transient startup races/cold boots.
          autoStartRetryTimerRef.current = window.setTimeout(() => {
        autoStartRetryTimerRef.current = null;
        if (!devServerStartingRef.current) {
          void handleStartDevServer({
            showErrorToast: false,
            maxAttempts: 4,
            retryDelays: [3000, 5000, 7000],
            source: 'auto',
          });
        }
      }, 12000);
    }

    devServerStartingRef.current = false;
    setIsStartingDevServer(false);
    return false;
  };

  const handleStopDevServer = async () => {
    if (!devServer) return;

    try {
      clearAutoStartRetry();
      clearAutoStartSuppression();
      await devServerApi.stop(projectId);
      await loadPreviewState();
      toast.success('Dev server stopped');
    } catch (error: any) {
      console.error('Failed to stop dev server:', error);
      toast.error(`Failed to stop dev server: ${getErrorMessage(error)}`);
    }
  };

  const handleRefresh = () => {
    console.log('Manually refreshing preview');
    setIframeReloadKey(prev => prev + 1); // Force iframe remount
    void loadPreviewState();
    toast.success('Preview refreshed');
  };

  const handleOpenInBrowser = useCallback(() => {
    if (!currentUrl) return;
    void openExternal(currentUrl);
  }, [currentUrl]);

  useEffect(() => {
    if (!isEngaged) return;
    if (currentUrl) return;
    if (hasActiveAiRun) return; // Don't auto-start while AI is building
    if (!previewState?.canAutoStartDevServer) return;
    if (devServer?.running) return;
    if (devServerStartingRef.current) return;
    if (isAutoStartSuppressed()) return;
    if (Date.now() < autoStartCooldownUntilRef.current) return;

    void handleStartDevServer({
      showErrorToast: false,
      maxAttempts: 6,
      retryDelays: [2000, 3000, 5000, 7000, 10000],
      source: 'auto',
    });
  }, [currentUrl, devServer?.running, isEngaged, previewState, projectId]);

  const previewStatusText = displayUrl || (
    previewStateName === 'dev_server_live'
      ? 'Live preview ready'
      : previewStateName === 'starting_dev_server'
        ? 'Starting development server...'
        : previewStateName === 'dev_server_ready'
          ? 'Dev server ready to start'
          : previewStateName === 'dev_server_error'
            ? 'Dev server failed to start'
          : previewStateName === 'scaffolding'
            ? 'Setting up preview...'
            : previewStateName === 'empty'
              ? 'Nothing to preview yet'
              : 'No preview available'
  );

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--review-panel-alt-bg)' }}>
      {/* URL Bar */}
      <div style={{
        padding: '10px 12px',
        background: 'var(--review-panel-header-bg)',
        borderBottom: '1px solid var(--review-shell-border)',
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-2)',
      }}>
        <button
          onClick={handleRefresh}
          title="Refresh preview"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '6px 12px',
            background: 'var(--review-segment-bg)',
            border: '1px solid var(--review-shell-border)',
            borderRadius: 'var(--radius-md)',
            fontSize: 'var(--text-sm)',
            fontFamily: 'var(--font-sans)',
            color: 'var(--text-secondary)',
            cursor: 'pointer',
            transition: 'border-color var(--transition-fast), color var(--transition-fast)',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--review-shell-border-strong)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--review-shell-border)'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
        >
          <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          Refresh
        </button>
        <div style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          background: 'var(--review-code-bg)',
          border: '1px solid var(--review-shell-border)',
          borderRadius: 'var(--radius-md)',
          padding: '6px 12px',
          fontSize: 'var(--text-sm)',
        }}>
          <svg width="16" height="16" fill="none" stroke="var(--text-tertiary)" viewBox="0 0 24 24" style={{ marginRight: 8, flexShrink: 0 }}>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
          </svg>
          <span style={{ color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {previewStatusText}
          </span>
          {currentUrl && (
            <button
              onClick={handleOpenInBrowser}
              title="Open preview in browser"
              style={{
                marginLeft: 'auto',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 20,
                height: 20,
                padding: 0,
                border: 'none',
                background: 'transparent',
                color: 'var(--text-tertiary)',
                cursor: 'pointer',
                flexShrink: 0,
                transition: 'color var(--transition-fast)',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text-primary)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-tertiary)'; }}
            >
              <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5h5m0 0v5m0-5L10 14" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 7H7a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2v-2" />
              </svg>
            </button>
          )}
        </div>
        {devServer && devServer.running ? (
          <button
            onClick={handleStopDevServer}
            title="Stop dev server"
            style={{
              padding: '6px 12px',
              background: 'transparent',
              border: '1px solid var(--accent-red)',
              borderRadius: 'var(--radius-md)',
              fontSize: 'var(--text-sm)',
              fontFamily: 'var(--font-sans)',
              color: 'var(--accent-red)',
              cursor: 'pointer',
              transition: 'background var(--transition-fast)',
              whiteSpace: 'nowrap',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(248, 81, 73, 0.15)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            Stop
          </button>
        ) : (
          <button
            onClick={() => { void handleStartDevServer(); }}
            disabled={isPreviewLaunching || !previewState?.canManualStartDevServer}
            title="Start dev server for HMR"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '6px 12px',
              background: 'var(--review-segment-bg)',
              border: '1px solid var(--review-shell-border)',
              borderRadius: 'var(--radius-md)',
              fontSize: 'var(--text-sm)',
              fontFamily: 'var(--font-sans)',
              color: 'var(--text-secondary)',
              cursor: (isPreviewLaunching || !previewState?.canManualStartDevServer) ? 'not-allowed' : 'pointer',
              opacity: (isPreviewLaunching || !previewState?.canManualStartDevServer) ? 0.5 : 1,
              transition: 'border-color var(--transition-fast), color var(--transition-fast)',
              whiteSpace: 'nowrap',
            }}
            onMouseEnter={(e) => { if (!isPreviewLaunching && previewState?.canManualStartDevServer) { e.currentTarget.style.borderColor = 'var(--review-shell-border-strong)'; e.currentTarget.style.color = 'var(--text-primary)'; } }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--review-shell-border)'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
          >
            <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            {isPreviewLaunching ? 'Starting...' : 'Start Dev Server'}
          </button>
        )}
      </div>

      {/* Preview iframe */}
      <div className="flex-1 relative" style={{ background: 'var(--review-code-bg)' }}>
        {/* Message: Dev server stopped — minimal text + link */}
        {!currentUrl && previewStateName === 'dev_server_ready' && !isPreviewLaunching && (
          <div style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--bg-base)',
            zIndex: 10,
          }}>
            <div style={{ textAlign: 'center' }}>
              <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', marginBottom: 'var(--space-2)' }}>
                Dev server stopped
              </p>
              <button
                onClick={() => { void handleStartDevServer(); }}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--accent-blue)',
                  fontSize: 'var(--text-sm)',
                  fontFamily: 'var(--font-sans)',
                  cursor: 'pointer',
                  textDecoration: 'none',
                  transition: 'opacity var(--transition-fast)',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.8'; }}
                onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
              >
                Start Dev Server
              </button>
            </div>
          </div>
        )}

        {!currentUrl && previewStateName === 'dev_server_error' && !isPreviewLaunching && (
          <div style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--bg-base)',
            zIndex: 10,
            padding: '24px',
          }}>
            <div style={{ textAlign: 'center', maxWidth: 420 }}>
              <p style={{ fontSize: 'var(--text-sm)', color: 'var(--accent-red)', marginBottom: 'var(--space-2)' }}>
                Dev server failed to start
              </p>
              <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginBottom: 'var(--space-3)' }}>
                {previewState?.devServer?.error || 'Atlas could not launch the project preview. You can retry once the app scaffold is ready.'}
              </p>
              <button
                onClick={() => { void handleStartDevServer({ source: 'manual' }); }}
                disabled={isPreviewLaunching || !previewState?.canManualStartDevServer}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--accent-blue)',
                  fontSize: 'var(--text-sm)',
                  fontFamily: 'var(--font-sans)',
                  cursor: (isPreviewLaunching || !previewState?.canManualStartDevServer) ? 'not-allowed' : 'pointer',
                  opacity: (isPreviewLaunching || !previewState?.canManualStartDevServer) ? 0.5 : 1,
                  transition: 'opacity var(--transition-fast)',
                }}
              >
                Retry dev server
              </button>
            </div>
          </div>
        )}

        {!currentUrl && previewStateName === 'scaffolding' && (
          <div style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--bg-base)',
            zIndex: 10,
            padding: '24px',
          }}>
            <div style={{ textAlign: 'center', maxWidth: 360 }}>
              <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginBottom: 'var(--space-1)' }}>
                Setting up project preview...
              </p>
              <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
                Atlas is waiting for a stable preview target before switching this panel.
              </p>
            </div>
          </div>
        )}

        {/* Loading state: Starting dev server */}
        {isPreviewLaunching && (
          <div style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--bg-base)',
            zIndex: 10,
          }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ marginBottom: 'var(--space-3)' }}>
                <svg className="animate-spin" width="32" height="32" fill="none" viewBox="0 0 24 24" style={{ margin: '0 auto', color: 'var(--accent-blue)' }}>
                  <circle style={{ opacity: 0.25 }} cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path style={{ opacity: 0.75 }} fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
              </div>
              <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginBottom: 'var(--space-1)' }}>Starting development server...</p>
              <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>This may take a minute on first run</p>
            </div>
          </div>
        )}

        {!currentUrl && previewStateName === 'empty' && !isPreviewLaunching && (
          <div style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--bg-base)',
            zIndex: 10,
            padding: '24px',
          }}>
            <div style={{ textAlign: 'center', maxWidth: 420 }}>
              <div style={{
                width: 52,
                height: 52,
                borderRadius: 16,
                margin: '0 auto 16px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'rgba(34, 211, 238, 0.12)',
                border: '1px solid rgba(34, 211, 238, 0.28)',
                color: '#22d3ee',
              }}>
                <svg width="28" height="28" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L8.5 20h7L14.25 17M6 4h12a2 2 0 012 2v8a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2z" />
                </svg>
              </div>
              <h2 style={{
                margin: 0,
                fontSize: 'clamp(16px, 1.8vw, 24px)',
                lineHeight: 1.1,
                fontWeight: 700,
                color: 'var(--text-primary)',
                letterSpacing: '-0.04em',
              }}>
                Nothing to preview yet
              </h2>
              <p style={{
                margin: '10px 0 0',
                fontSize: 'clamp(10px, 1vw, 13px)',
                lineHeight: 1.35,
                color: 'var(--text-tertiary)',
              }}>
                Start building by telling the AI what you want to create.
              </p>
            </div>
          </div>
        )}

        {currentUrl && hasActiveAiRun && (
          <div
            style={{
              position: 'absolute',
              top: 12,
              right: 12,
              zIndex: 20,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '7px 10px',
              borderRadius: 999,
              background: 'rgba(17, 24, 39, 0.82)',
              border: '1px solid rgba(34, 211, 238, 0.22)',
              color: 'var(--text-secondary)',
              fontSize: '12px',
              backdropFilter: 'blur(10px)',
            }}
          >
            <span
              className="animate-pulse"
              style={{
                width: 8,
                height: 8,
                borderRadius: 999,
                background: '#22d3ee',
                boxShadow: '0 0 0 0 rgba(34, 211, 238, 0.55)',
              }}
            />
            AI is building...
          </div>
        )}

        {isSelectingUi && (
          <div className="absolute top-3 left-3 z-20 rounded bg-accent-blue/90 px-3 py-1 text-xs text-content shadow">
            Click an element to select it for chat
          </div>
        )}

        {pickingElementForStep !== null && (
          <div className="absolute top-3 left-3 z-20 rounded bg-accent-purple/90 px-3 py-1 text-xs text-content shadow">
            Click an element to use its selector for step {pickingElementForStep + 1}
          </div>
        )}

        {isRunningTest && (
          <div className="absolute top-3 left-3 z-20 rounded bg-accent-green/90 px-3 py-1 text-xs text-content shadow flex items-center gap-2">
            <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            Running test...
          </div>
        )}

        {isRecording && (
          <div className="absolute top-3 left-3 z-20 rounded bg-accent-red/90 px-3 py-1 text-xs text-content shadow flex items-center gap-2">
            <span className="w-2 h-2 bg-content rounded-full animate-pulse"></span>
            Recording...
          </div>
        )}

        {/* Single iframe that updates src based on preview type */}
        <iframe
          ref={iframeRef}
          key={`preview-${projectId}-${iframeReloadKey}`}
          src={currentUrl || 'about:blank'}
          className={`w-full h-full border-0 ${!currentUrl ? 'hidden' : ''}`}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          title={
            devServer?.running
              ? 'Dev Server Preview'
              : 'Static Preview'
          }
          onLoad={() => {
            setIframeReady(true);
            setUiSelectionReady(false);
            setUiSelectionVersion(null);
            setTimeout(() => {
              iframeRef.current?.contentWindow?.postMessage({ type: 'atlas-ui-version-request' }, '*');
            }, 50);
            if (isSelectingUi || pickingElementForStep !== null) {
              setTimeout(() => sendSelectionToggle(true), 50);
            }
          }}
        />
      </div>
    </div>
  );
});

PreviewPanel.displayName = 'PreviewPanel';

export default PreviewPanel;
