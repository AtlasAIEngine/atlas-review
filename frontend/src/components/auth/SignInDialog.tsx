import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchReviewSync, setReviewSyncAuthToken } from '@/services/api';
import DeviceCodeDisplay from '@/components/DeviceCodeDisplay';
import { useCurrentUser, type CurrentUser } from '@/contexts/CurrentUserContext';
import toast from '@/lib/toast';

interface SignInDialogProps {
  open: boolean;
  onClose: () => void;
}

type DeviceFlowState =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | {
      kind: 'waiting';
      userCode: string;
      verificationUri: string;
      interval: number;
    }
  | { kind: 'success'; user: CurrentUser | null }
  | { kind: 'error'; message: string };

interface StartResponse {
  success: boolean;
  deviceFlow: {
    userCode: string;
    verificationUri: string;
    expiresIn: number;
    interval: number;
  };
}

interface PollResponse {
  success: boolean;
  status: 'authorization_pending' | 'slow_down' | 'expired' | 'linked';
  interval?: number;
  user?: CurrentUser | null;
  authToken?: string | null;
  merged?: boolean;
}

async function openExternalUrl(url: string) {
  // Prefer Tauri's shell plugin; fall back to window.open for the web shell.
  try {
    const mod = await import('@tauri-apps/plugin-shell');
    await mod.open(url);
    return;
  } catch {
    /* noop */
  }
  try {
    window.open(url, '_blank', 'noopener,noreferrer');
  } catch {
    /* noop */
  }
}

export default function SignInDialog({ open, onClose }: SignInDialogProps) {
  const [state, setState] = useState<DeviceFlowState>({ kind: 'idle' });
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cancelledRef = useRef(false);
  const primaryButtonRef = useRef<HTMLButtonElement>(null);
  const { onSignedIn, refresh } = useCurrentUser();

  const clearPoll = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const startFlow = useCallback(async () => {
    cancelledRef.current = false;
    setState({ kind: 'starting' });
    try {
      const res = await fetchReviewSync<StartResponse>('/review-sync/github/start', {
        method: 'POST',
      });
      if (cancelledRef.current) return;
      if (!res?.deviceFlow?.userCode) {
        setState({ kind: 'error', message: 'GitHub did not return a device code.' });
        return;
      }
      setState({
        kind: 'waiting',
        userCode: res.deviceFlow.userCode,
        verificationUri: res.deviceFlow.verificationUri,
        // Frontend polls the local backend, not GitHub directly — the
        // backend owns the GitHub-facing interval + slow_down handling.
        // Keep local polling at 1 s for responsiveness; `slow_down` from
        // the server still triggers exponential backoff below.
        interval: 1,
      });
      // Auto-open the verification page on success — saves a click.
      void openExternalUrl(res.deviceFlow.verificationUri);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start GitHub sign-in.';
      setState({ kind: 'error', message });
    }
  }, []);

  // Reset state whenever the dialog opens/closes. Does NOT kick off the flow —
  // the user confirms by clicking the GitHub button on the landing step.
  useEffect(() => {
    if (open) {
      cancelledRef.current = false;
      setState({ kind: 'idle' });
      // Focus the primary CTA so keyboard users can Enter straight through.
      queueMicrotask(() => primaryButtonRef.current?.focus());
    } else {
      clearPoll();
      cancelledRef.current = true;
      setState({ kind: 'idle' });
    }
    return () => {
      clearPoll();
      cancelledRef.current = true;
    };
  }, [open, clearPoll]);

  // Escape-to-close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Poll GitHub while the user is approving the device code.
  useEffect(() => {
    if (state.kind !== 'waiting') return;

    let intervalMs = Math.max(1, state.interval) * 1000;

    const tick = async () => {
      if (cancelledRef.current) return;
      try {
        const res = await fetchReviewSync<PollResponse>('/review-sync/github/poll', {
          method: 'POST',
        });
        if (cancelledRef.current) return;
        if (res.status === 'authorization_pending') return;
        if (res.status === 'slow_down') {
          intervalMs = Math.min(60_000, intervalMs * 2);
          clearPoll();
          intervalRef.current = setInterval(tick, intervalMs);
          return;
        }
        if (res.status === 'expired') {
          clearPoll();
          setState({ kind: 'error', message: 'The sign-in code expired. Please try again.' });
          return;
        }
        if (res.status === 'linked') {
          clearPoll();
          if (res.authToken) {
            setReviewSyncAuthToken(res.authToken);
          }
          onSignedIn({ authToken: res.authToken ?? null, user: res.user ?? null });
          if (!res.user) {
            await refresh();
          }
          setState({ kind: 'success', user: res.user ?? null });
          toast.success('Connected GitHub');
        }
      } catch (err) {
        clearPoll();
        const message = err instanceof Error ? err.message : 'Sign-in polling failed.';
        setState({ kind: 'error', message });
      }
    };

    intervalRef.current = setInterval(tick, intervalMs);
    // Fire one immediate poll so the user doesn't wait the full interval after approving.
    void tick();
    return clearPoll;
  }, [state, clearPoll, onSignedIn, refresh]);

  if (!open) return null;

  const showLanding = state.kind === 'idle' || state.kind === 'starting';
  const loading = state.kind === 'starting';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="signin-title"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 2000,
        padding: 24,
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-lg)',
          padding: 32,
          maxWidth: 400,
          width: '100%',
          boxShadow: '0 20px 48px rgba(0,0,0,0.45)',
          fontFamily: 'var(--font-sans)',
        }}
      >
        {showLanding ? (
          <LandingStep
            primaryButtonRef={primaryButtonRef}
            onContinue={() => void startFlow()}
            onCancel={onClose}
            loading={loading}
          />
        ) : state.kind === 'waiting' ? (
          <WaitingStep
            userCode={state.userCode}
            onOpenGitHub={() => void openExternalUrl(state.verificationUri)}
            onCancel={onClose}
          />
        ) : state.kind === 'success' ? (
          <SuccessStep login={state.user?.github_login ?? null} onDone={onClose} />
        ) : (
          <ErrorStep
            message={state.message}
            onRetry={() => void startFlow()}
            onCancel={onClose}
          />
        )}
      </div>
    </div>
  );
}

// ---- Sub-steps ----

function LandingStep({
  primaryButtonRef,
  onContinue,
  onCancel,
  loading,
}: {
  primaryButtonRef: React.RefObject<HTMLButtonElement>;
  onContinue: () => void;
  onCancel: () => void;
  loading: boolean;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center' }}>
      <div
        aria-hidden
        style={{
          width: 48,
          height: 48,
          borderRadius: '50%',
          background: 'var(--bg-overlay)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 18,
          color: 'var(--text-primary)',
        }}
      >
        <GitHubIcon size={24} />
      </div>

      <h2
        id="signin-title"
        style={{ margin: 0, fontSize: 18, fontWeight: 600, color: 'var(--text-primary)', letterSpacing: '-0.01em' }}
      >
        Connect GitHub
      </h2>
      <p
        style={{
          margin: '8px 0 0',
          fontSize: 13,
          lineHeight: 1.5,
          color: 'var(--text-secondary)',
          maxWidth: 280,
        }}
      >
        Connect this device's review history and repository access to one GitHub account.
      </p>

      <button
        type="button"
        ref={primaryButtonRef}
        onClick={onContinue}
        disabled={loading}
        style={{
          ...primaryButtonStyle,
          marginTop: 24,
          width: '100%',
          padding: '10px 14px',
          gap: 8,
          opacity: loading ? 0.7 : 1,
          cursor: loading ? 'progress' : 'pointer',
        }}
      >
        {loading ? (
          <>
            <Spinner />
            <span>Connecting to GitHub…</span>
          </>
        ) : (
          <>
            <GitHubIcon size={16} />
            <span>Connect GitHub</span>
          </>
        )}
      </button>

      <button
        type="button"
        onClick={onCancel}
        style={{
          marginTop: 12,
          background: 'transparent',
          border: 'none',
          color: 'var(--text-tertiary)',
          fontSize: 12,
          cursor: 'pointer',
          padding: 6,
        }}
      >
        Not now
      </button>

      <p
        style={{
          margin: '16px 0 0',
          fontSize: 11,
          color: 'var(--text-tertiary)',
          lineHeight: 1.5,
          maxWidth: 280,
        }}
      >
        GitHub connection is optional. You can keep using Atlas without it.
      </p>
    </div>
  );
}

function WaitingStep({
  userCode,
  onOpenGitHub,
  onCancel,
}: {
  userCode: string;
  onOpenGitHub: () => void;
  onCancel: () => void;
}) {
  return (
    <div>
      <h2 id="signin-title" style={{ margin: 0, fontSize: 16, fontWeight: 600, color: 'var(--text-primary)' }}>
        Connect on GitHub
      </h2>

      <div style={{ marginTop: 16, textAlign: 'center' }}>
        <DeviceCodeDisplay deviceCode={userCode} variant="dark" />
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
        <button type="button" onClick={onOpenGitHub} style={{ ...primaryButtonStyle, flex: 1 }}>
          Open GitHub
        </button>
        <button type="button" onClick={onCancel} style={{ ...secondaryButtonStyle, flex: 1 }}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function SuccessStep({ login, onDone }: { login: string | null; onDone: () => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center' }}>
      <div
        aria-hidden
        style={{
          width: 48,
          height: 48,
          borderRadius: '50%',
          background: 'rgba(74, 222, 128, 0.15)',
          color: 'var(--accent-green, #4ade80)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 16,
          fontSize: 24,
        }}
      >
        ✓
      </div>
      <h2 id="signin-title" style={{ margin: 0, fontSize: 16, fontWeight: 600, color: 'var(--text-primary)' }}>
        {login ? `Connected as @${login}` : 'GitHub connected'}
      </h2>
      <p style={{ margin: '8px 0 20px', fontSize: 12, color: 'var(--text-secondary)' }}>
        Your review history and GitHub access now use this account.
      </p>
      <button type="button" onClick={onDone} style={{ ...primaryButtonStyle, width: '100%' }}>
        Done
      </button>
    </div>
  );
}

function ErrorStep({
  message,
  onRetry,
  onCancel,
}: {
  message: string;
  onRetry: () => void;
  onCancel: () => void;
}) {
  return (
    <div>
      <h2 id="signin-title" style={{ margin: 0, fontSize: 16, fontWeight: 600, color: 'var(--text-primary)' }}>
        GitHub connection failed
      </h2>
      <p style={{ margin: '8px 0 16px', fontSize: 12, color: 'var(--accent-red, #ef4444)', lineHeight: 1.5 }}>
        {message}
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" onClick={onRetry} style={{ ...primaryButtonStyle, flex: 1 }}>
          Try again
        </button>
        <button type="button" onClick={onCancel} style={{ ...secondaryButtonStyle, flex: 1 }}>
          Close
        </button>
      </div>
    </div>
  );
}

// ---- Bits ----

function GitHubIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2.01c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.76 2.69 1.25 3.35.95.1-.75.4-1.25.73-1.54-2.55-.29-5.23-1.28-5.23-5.7 0-1.26.45-2.29 1.18-3.09-.12-.29-.51-1.46.11-3.04 0 0 .97-.31 3.18 1.18a11 11 0 0 1 2.9-.39c.99 0 1.98.13 2.9.39 2.2-1.49 3.17-1.18 3.17-1.18.63 1.58.23 2.75.11 3.04.74.8 1.18 1.83 1.18 3.09 0 4.43-2.69 5.4-5.25 5.69.41.36.77 1.06.77 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z" />
    </svg>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-block',
        width: 14,
        height: 14,
        border: '2px solid currentColor',
        borderRightColor: 'transparent',
        borderRadius: '50%',
        animation: 'atlas-signin-spin 0.8s linear infinite',
      }}
    />
  );
}

// Inject the spinner keyframes once per page load.
if (typeof document !== 'undefined' && !document.getElementById('atlas-signin-spin-style')) {
  const s = document.createElement('style');
  s.id = 'atlas-signin-spin-style';
  s.textContent = '@keyframes atlas-signin-spin { to { transform: rotate(360deg); } }';
  document.head.appendChild(s);
}

const primaryButtonStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '8px 14px',
  fontSize: 13,
  fontWeight: 500,
  color: 'var(--text-inverse, #fff)',
  background: 'var(--accent-blue)',
  border: 'none',
  borderRadius: 'var(--radius-md)',
  cursor: 'pointer',
};

const secondaryButtonStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '8px 14px',
  fontSize: 13,
  fontWeight: 500,
  color: 'var(--text-secondary)',
  background: 'transparent',
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--radius-md)',
  cursor: 'pointer',
};
