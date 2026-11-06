/**
 * PublishDialog — Modal for cloud deployment with free/paid options.
 *
 * State machine: idle → checking → checkout → activating → packaging → uploading → building → live
 */

import { useState, useEffect, useCallback } from 'react';
import toast from '@/lib/toast';
import * as deployApi from '../services/deployApi';
import * as checkoutService from '../services/checkoutService';
import { fetchProjectArchive, uploadArtifact } from '../services/artifactService';
import * as keyManager from '../services/keyManager';
import DeployProgress from './DeployProgress';
import { getReviewActionButtonStyle } from './review/ReviewChrome';

interface PublishDialogProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
  projectName: string;
}

type PublishState =
  | 'idle'
  | 'checking'
  | 'checkout'
  | 'activating'
  | 'packaging'
  | 'uploading'
  | 'building'
  | 'live'
  | 'error';

export default function PublishDialog({ isOpen, onClose, projectId, projectName }: PublishDialogProps) {
  const [state, setState] = useState<PublishState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [deploymentId, setDeploymentId] = useState<number | null>(null);
  const [liveUrl, setLiveUrl] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [paymentsEnabled, setPaymentsEnabled] = useState(true); // default to showing tiers until we know

  // Reset state when dialog opens; fetch config
  useEffect(() => {
    if (isOpen) {
      setState('idle');
      setErrorMessage(null);
      setDeploymentId(null);
      setLiveUrl(null);
      setUploadProgress(0);

      deployApi.getConfig()
        .then(cfg => setPaymentsEnabled(cfg.paymentsEnabled))
        .catch(() => setPaymentsEnabled(true)); // on error, fall back to showing tiers
    }
  }, [isOpen]);

  // Escape key handler — only allow closing when safe (not mid-deploy)
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && (state === 'idle' || state === 'live' || state === 'error')) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen, onClose, state]);

  const startPublish = useCallback(async (tier: 'free' | 'paid') => {
    try {
      // Ensure key manager is initialized
      if (!keyManager.isInitialized()) {
        await keyManager.initialize();
      }

      setState('checking');

      // Step 1: Init — register device, get token/checkout URL
      const initResult = await deployApi.init(projectName, tier);

      let orderId: string | undefined;

      if (!paymentsEnabled && initResult.data.bypassToken) {
        // Payments disabled — skip straight to push with no credentials
      } else if (tier === 'paid' && initResult.data.checkoutUrl) {
        // Open LemonSqueezy overlay
        setState('checkout');
        try {
          const orderNumber = await checkoutService.openCheckout(initResult.data.checkoutUrl);
          setState('activating');

          // Poll for webhook processing (license creation)
          const maxWaitMs = 30000;
          const pollIntervalMs = 2000;
          const startTime = Date.now();
          let licenseReady = false;

          while (Date.now() - startTime < maxWaitMs) {
            const status = await deployApi.getOrderStatus(orderNumber);
            if (status.data.ready) {
              licenseReady = true;
              orderId = orderNumber;
              break;
            }
            await new Promise(r => setTimeout(r, pollIntervalMs));
          }

          if (!licenseReady) {
            setErrorMessage('Payment received but license activation is taking longer than expected. Please try again in a few minutes.');
            setState('error');
            return;
          }
        } catch (err) {
          setErrorMessage('Checkout was cancelled or timed out');
          setState('error');
          return;
        }
      }

      // Step 2: Push — get pre-signed upload URL
      const pushResult = await deployApi.push({
        projectName,
        ...(!paymentsEnabled ? {} : { freeToken: initResult.data.freeToken, orderId }),
      });

      setDeploymentId(pushResult.data.deploymentId);

      // Step 3: Package — download archive from local backend
      setState('packaging');
      const archive = await fetchProjectArchive(projectId);

      // Step 4: Upload — PUT to R2
      setState('uploading');
      await uploadArtifact(pushResult.data.uploadUrl, archive, setUploadProgress);

      // Step 5: Finalize — trigger build
      setState('building');
      await deployApi.finalize(pushResult.data.deploymentId);

      // DeployProgress component takes over from here via polling

    } catch (err: any) {
      console.error('[PublishDialog] Error:', err);
      setErrorMessage(err.response?.data?.error || err.message || 'Publish failed');
      setState('error');
    }
  }, [projectId, projectName]);

  const handleDeployComplete = useCallback((url: string) => {
    setLiveUrl(url);
    setState('live');
    toast.success('Deployment is live!');
  }, []);

  const handleDeployError = useCallback((error: string) => {
    setErrorMessage(error);
    setState('error');
  }, []);

  if (!isOpen) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9998,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(var(--bg-base-rgb), 0.58)',
        backdropFilter: 'blur(10px)',
        padding: '24px',
      }}
      onClick={(e) => { if (e.target === e.currentTarget && state === 'idle') onClose(); }}
    >
      <div style={{
        width: 520,
        maxWidth: '90vw',
        background: 'var(--review-shell-bg)',
        border: '1px solid var(--review-shell-border-strong)',
        borderRadius: 18,
        boxShadow: 'var(--review-panel-shadow)',
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '20px 24px 16px',
          borderBottom: '1px solid var(--review-shell-divider)',
          background: 'var(--review-panel-header-bg)',
        }}>
          <h2 style={{
            margin: 0,
            fontSize: 'var(--text-lg)',
            fontWeight: 600,
            color: 'var(--text-primary)',
          }}>
            Publish to Cloud
          </h2>
          {(state === 'idle' || state === 'live' || state === 'error') && (
            <button
              type="button"
              onClick={onClose}
              style={{
                ...getReviewActionButtonStyle({ tone: 'neutral' }),
                width: 28,
                minHeight: 28,
                borderRadius: 10,
                color: 'var(--text-tertiary)',
                cursor: 'pointer',
                fontSize: 'var(--text-lg)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = 'var(--text-primary)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = 'var(--text-tertiary)';
              }}
            >
              &times;
            </button>
          )}
        </div>

        {/* Content */}
        <div style={{ padding: 'var(--space-5)', background: 'var(--review-panel-alt-bg)' }}>
          {state === 'idle' && (
            <div>
              <p style={{
                color: 'var(--text-secondary)',
                fontSize: 'var(--text-sm)',
                margin: '0 0 var(--space-4) 0',
                lineHeight: 1.5,
              }}>
                Deploy <strong style={{ color: 'var(--text-primary)' }}>{projectName}</strong> to a live subdomain on atlasengine.dev.
              </p>

              {!paymentsEnabled ? (
                /* Payments disabled — single deploy button, no tier selection */
                <button
                  type="button"
                  onClick={() => startPublish('free')}
                  style={{
                    ...getReviewActionButtonStyle({ tone: 'blue', active: true }),
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '0 var(--space-4)',
                    minHeight: 40,
                    borderRadius: 12,
                    fontSize: 'var(--text-sm)',
                    fontWeight: 700,
                    cursor: 'pointer',
                    transition: 'opacity var(--transition-fast)',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.9'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
                >
                  Deploy
                </button>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                  {/* Free tier */}
                  <button
                    type="button"
                    onClick={() => startPublish('free')}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: 'var(--space-4)',
                      background: 'var(--review-card-bg)',
                      border: '1px solid var(--review-shell-border)',
                      borderRadius: 14,
                      cursor: 'pointer',
                      transition: 'border-color var(--transition-fast), background var(--transition-fast)',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.borderColor = 'var(--review-shell-border-strong)';
                      e.currentTarget.style.background = 'var(--review-card-hover)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.borderColor = 'var(--review-shell-border)';
                      e.currentTarget.style.background = 'var(--review-card-bg)';
                    }}
                  >
                    <div style={{ textAlign: 'left' }}>
                      <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>
                        Free — 7 days
                      </div>
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginTop: 2 }}>
                        Try it out. Expires automatically.
                      </div>
                    </div>
                    <div style={{ fontSize: 'var(--text-lg)', fontWeight: 700, color: 'var(--text-primary)' }}>
                      $0
                    </div>
                  </button>

                  {/* Paid tier */}
                  <button
                    type="button"
                    onClick={() => startPublish('paid')}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: 'var(--space-4)',
                      background: 'var(--review-card-hover)',
                      border: '1px solid var(--review-shell-border-strong)',
                      borderRadius: 14,
                      cursor: 'pointer',
                      transition: 'background var(--transition-fast), border-color var(--transition-fast)',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'var(--review-card-hover)';
                      e.currentTarget.style.borderColor = 'var(--review-segment-active-border)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'var(--review-card-hover)';
                      e.currentTarget.style.borderColor = 'var(--review-shell-border-strong)';
                    }}
                  >
                    <div style={{ textAlign: 'left' }}>
                      <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>
                        Keep Live — Forever
                      </div>
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginTop: 2 }}>
                        One-time payment. No subscription.
                      </div>
                    </div>
                    <div style={{ fontSize: 'var(--text-lg)', fontWeight: 700, color: 'var(--accent-blue)' }}>
                      $7
                    </div>
                  </button>
                </div>
              )}
            </div>
          )}

          {(state === 'checking' || state === 'checkout' || state === 'activating') && (
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              padding: 'var(--space-6) 0',
              gap: 'var(--space-3)',
            }}>
              <div className="animate-spin" style={{
                width: 24,
                height: 24,
                borderRadius: '50%',
                border: '3px solid var(--review-shell-border)',
                borderTopColor: 'var(--accent-blue)',
              }} />
              <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>
                {state === 'checking' && 'Preparing deployment...'}
                {state === 'checkout' && 'Complete payment in the overlay...'}
                {state === 'activating' && 'Activating license...'}
              </span>
            </div>
          )}

          {(state === 'packaging' || state === 'uploading') && (
            <div style={{ padding: 'var(--space-4) 0' }}>
              <div style={{
                fontSize: 'var(--text-sm)',
                color: 'var(--text-secondary)',
                marginBottom: 'var(--space-3)',
              }}>
                {state === 'packaging' ? 'Packaging project...' : `Uploading... ${uploadProgress}%`}
              </div>
              {state === 'uploading' && (
                <div style={{
                  width: '100%',
                  height: 6,
                  background: 'var(--review-code-bg)',
                  borderRadius: 3,
                  overflow: 'hidden',
                }}>
                  <div style={{
                    width: `${uploadProgress}%`,
                    height: '100%',
                    background: 'var(--accent-blue)',
                    transition: 'width 0.3s ease',
                  }} />
                </div>
              )}
            </div>
          )}

          {state === 'building' && deploymentId && (
            <DeployProgress
              deploymentId={deploymentId}
              onComplete={handleDeployComplete}
              onError={handleDeployError}
            />
          )}

          {state === 'live' && liveUrl && (
            <div style={{
              textAlign: 'center',
              padding: 'var(--space-4) 0',
            }}>
              <div style={{
                width: 48,
                height: 48,
                borderRadius: '50%',
                background: 'var(--status-success)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto var(--space-3)',
                fontSize: 24,
                color: '#fff',
              }}>
                &#x2713;
              </div>
              <h3 style={{
                margin: '0 0 var(--space-2) 0',
                fontSize: 'var(--text-base)',
                fontWeight: 600,
                color: 'var(--text-primary)',
              }}>
                Your project is live!
              </h3>
              <a
                href={liveUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  color: 'var(--accent-blue)',
                  fontSize: 'var(--text-sm)',
                  textDecoration: 'none',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.textDecoration = 'underline'; }}
                onMouseLeave={(e) => { e.currentTarget.style.textDecoration = 'none'; }}
              >
                {liveUrl}
              </a>
              <div style={{ marginTop: 'var(--space-4)' }}>
                <button
                  type="button"
                  onClick={onClose}
                  style={{
                    ...getReviewActionButtonStyle({ tone: 'blue', active: true }),
                    padding: '0 var(--space-4)',
                    minHeight: 32,
                    borderRadius: 10,
                    fontSize: 'var(--text-sm)',
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  Done
                </button>
              </div>
            </div>
          )}

          {state === 'error' && (
            <div style={{
              textAlign: 'center',
              padding: 'var(--space-4) 0',
            }}>
              <div style={{
                color: 'var(--status-error)',
                fontSize: 'var(--text-sm)',
                marginBottom: 'var(--space-3)',
              }}>
                {errorMessage || 'Deployment failed'}
              </div>
              <div style={{ display: 'flex', justifyContent: 'center', gap: 'var(--space-3)' }}>
                <button
                  type="button"
                  onClick={() => setState('idle')}
                  style={{
                    ...getReviewActionButtonStyle({ tone: 'neutral', active: true }),
                    padding: '0 var(--space-3)',
                    minHeight: 32,
                    borderRadius: 10,
                    fontSize: 'var(--text-sm)',
                    cursor: 'pointer',
                  }}
                >
                  Try Again
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  style={{
                    ...getReviewActionButtonStyle({ tone: 'neutral' }),
                    padding: '0 var(--space-3)',
                    minHeight: 32,
                    borderRadius: 10,
                    fontSize: 'var(--text-sm)',
                    cursor: 'pointer',
                  }}
                >
                  Close
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
