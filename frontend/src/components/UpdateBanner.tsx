/**
 * UpdateBanner Component
 * Shows desktop update state as a bottom-centered toast instead of a full-width bar.
 */

import { useUpdater } from '@/hooks/useUpdater';

function DownloadIcon() {
  return (
    <svg
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
      />
    </svg>
  );
}

function ErrorIcon() {
  return (
    <svg
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M12 9v4m0 4h.01M5.07 19h13.86c1.54 0 2.5-1.67 1.73-3L13.73 4c-.77-1.33-2.69-1.33-3.46 0L3.34 16c-.77 1.33.19 3 1.73 3z"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M5 13l4 4L19 7"
      />
    </svg>
  );
}

export function UpdateBanner() {
  const {
    isTauri,
    status,
    updateInfo,
    downloadProgress,
    error,
    checkForUpdate,
    downloadUpdate,
    dismiss,
  } = useUpdater();

  if (!isTauri || status === 'idle' || status === 'checking') {
    return null;
  }

  const isError = status === 'error';
  const isReady = status === 'ready';
  const isDownloading = status === 'downloading';
  const isUpToDate = status === 'up_to_date';

  const toneClasses = isError
    ? 'border-[rgba(239,68,68,0.28)] bg-[rgba(28,16,18,0.96)] text-[var(--text-primary)]'
    : (isReady || isUpToDate)
      ? 'border-[rgba(63,185,80,0.28)] bg-[rgba(18,28,22,0.96)] text-[var(--text-primary)]'
      : 'border-[rgba(88,166,255,0.28)] bg-[rgba(13,18,28,0.96)] text-[var(--text-primary)]';

  const iconClasses = isError
    ? 'text-[var(--accent-red)]'
    : (isReady || isUpToDate)
      ? 'text-[var(--accent-green)]'
      : 'text-[var(--accent-blue)]';

  const title = isError
    ? 'Update failed'
    : isReady
      ? 'Update ready'
      : isUpToDate
        ? 'AtlasEngine is up to date'
      : isDownloading
        ? 'Installing update'
        : `Update available: v${updateInfo?.version ?? ''}`;

  const description = isError
    ? (error || 'The update could not be downloaded right now.')
    : isReady
      ? 'Restart AtlasEngine to finish applying the update.'
      : isUpToDate
        ? 'You already have the latest desktop build installed.'
      : isDownloading
        ? `Downloading the latest build${downloadProgress !== null ? ` • ${Math.round(downloadProgress)}%` : ''}`
        : updateInfo?.currentVersion
          ? `v${updateInfo.version} is ready. Current version: v${updateInfo.currentVersion}`
          : 'A new desktop build is available.';

  // z-[10100] sits above the settings modal (9998), per-row controls inside
  // it (10001), and dialog overlays (10000) so the system-level update
  // notification is never hidden behind in-app modals.
  return (
    <div className="pointer-events-none fixed bottom-8 right-6 z-[10100] flex justify-end">
      <div
        role="status"
        aria-live="polite"
        className={`pointer-events-auto w-full max-w-[430px] rounded-3xl border shadow-[0_24px_60px_rgba(0,0,0,0.45)] backdrop-blur-xl transition-all duration-300 ${toneClasses}`}
      >
        <div className="flex items-start gap-3 px-4 py-3.5">
          <div className={`mt-0.5 flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-2xl border border-white/8 bg-white/5 ${iconClasses}`}>
            {isError ? <ErrorIcon /> : (isReady || isUpToDate) ? <CheckIcon /> : <DownloadIcon />}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold tracking-[0.01em] text-[var(--text-primary)]">
                  {title}
                </p>
                <p className="mt-0.5 text-sm leading-5 text-[var(--text-secondary)]">
                  {description}
                </p>
              </div>

              {(status === 'available' || status === 'error' || status === 'up_to_date') && (
                <button
                  onClick={dismiss}
                  className="rounded-xl p-1.5 text-[var(--text-tertiary)] transition-colors hover:bg-white/6 hover:text-[var(--text-primary)]"
                  aria-label="Dismiss update notice"
                >
                  <svg
                    className="h-4 w-4"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              )}
            </div>

            {isDownloading && downloadProgress !== null && (
              <div className="mt-2.5">
                <div className="h-1.5 overflow-hidden rounded-full bg-white/8">
                  <div
                    className="h-full rounded-full bg-[var(--accent-blue)] transition-all duration-300"
                    style={{ width: `${downloadProgress}%` }}
                  />
                </div>
              </div>
            )}

            {(status === 'available' || status === 'error') && (
              <div className="mt-3 flex items-center gap-2">
                {status === 'available' && (
                  <button
                    onClick={downloadUpdate}
                    className="rounded-xl bg-[var(--accent-blue)] px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-[#6da2ea]"
                  >
                    Update now
                  </button>
                )}

                {status === 'available' && (
                  <button
                    onClick={dismiss}
                    className="rounded-xl bg-[var(--surface-elevated)] px-3.5 py-2 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
                  >
                    Later
                  </button>
                )}

                {status === 'error' && (
                  <button
                    onClick={() => void checkForUpdate({ userInitiated: true })}
                    className="rounded-xl bg-[var(--surface-elevated)] px-3.5 py-2 text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-hover)]"
                  >
                    Retry
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default UpdateBanner;
