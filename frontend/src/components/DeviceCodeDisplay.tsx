/**
 * Device Code Display Component
 * Shows the GitHub device code with copy button and waiting spinner.
 * Shared across GitHubImportModal, GitHubPopover, and GitHubConnect.
 */

import toast from '@/lib/toast';

interface DeviceCodeDisplayProps {
  deviceCode: string;
  /** 'dark' for modal/popover (gray-900 backgrounds), 'light' for settings page */
  variant?: 'dark' | 'light' | 'compact';
}

export default function DeviceCodeDisplay({ deviceCode, variant = 'dark' }: DeviceCodeDisplayProps) {
  const handleCopy = () => {
    navigator.clipboard.writeText(deviceCode);
    toast.success('Code copied!');
  };

  if (variant === 'compact') {
    return (
      <>
        <p className="text-xs text-content-secondary mb-2">Enter this code on GitHub:</p>
        <button
          onClick={handleCopy}
          className="inline-flex items-center gap-2 px-4 py-2 bg-surface-elevated border border-border-strong rounded-lg hover:border-border transition-colors group mb-2"
          title="Click to copy"
        >
          <span className="text-2xl font-mono font-bold text-content tracking-[0.3em]">
            {deviceCode}
          </span>
          <CopyIcon className="w-4 h-4 text-content-tertiary group-hover:text-content" />
        </button>
        <div className="flex items-center justify-center gap-2 text-xs text-content-tertiary">
          <div className="w-3 h-3 border-2 border-border-strong border-t-content rounded-full animate-spin" />
          Waiting for GitHub approval...
        </div>
      </>
    );
  }

  if (variant === 'light') {
    return (
      <div className="mt-3">
        <p className="text-sm text-content-tertiary mb-2">Enter this code on GitHub:</p>
        <button
          onClick={handleCopy}
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-surface-elevated border-2 border-border rounded-xl hover:border-border-strong transition-colors group mb-2"
          title="Click to copy"
        >
          <span className="text-2xl font-mono font-bold text-content tracking-[0.3em]">
            {deviceCode}
          </span>
          <CopyIcon className="w-5 h-5 text-content-secondary group-hover:text-content-tertiary" />
        </button>
        <p className="text-xs text-content-tertiary mb-2">Click to copy, then paste on the GitHub page</p>
        <div className="flex items-center gap-2 text-sm text-content-tertiary">
          <div className="w-4 h-4 border-2 border-border border-t-border-strong rounded-full animate-spin" />
          Waiting for GitHub approval...
        </div>
      </div>
    );
  }

  // Default: dark variant (for modals)
  return (
    <>
      <p className="text-content-secondary mb-3">Enter this code on GitHub:</p>
      <button
        onClick={handleCopy}
        className="inline-flex items-center gap-2 px-6 py-3 bg-surface border-2 border-border-strong rounded-xl hover:border-border transition-colors group mb-3"
        title="Click to copy"
      >
        <span className="text-3xl font-mono font-bold text-content tracking-[0.3em]">
          {deviceCode}
        </span>
        <CopyIcon className="w-5 h-5 text-content-tertiary group-hover:text-content transition-colors" />
      </button>
      <p className="text-xs text-content-tertiary mb-4">Click to copy, then paste on the GitHub page</p>
      <div className="flex items-center justify-center gap-2 text-sm text-content-tertiary">
        <div className="w-4 h-4 border-2 border-border-strong border-t-content rounded-full animate-spin" />
        Waiting for GitHub approval...
      </div>
    </>
  );
}

function CopyIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
    </svg>
  );
}
