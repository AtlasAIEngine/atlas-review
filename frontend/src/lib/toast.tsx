import type { ReactNode } from 'react';
import hotToast, { Toaster as HotToaster, type ToastPosition } from 'react-hot-toast';

type AtlasToastVariant = 'info' | 'success' | 'error';

type AtlasToastOptions = {
  id?: string;
  duration?: number;
  position?: ToastPosition;
  icon?: ReactNode;
  description?: ReactNode;
  dismissible?: boolean;
};

const VARIANT_STYLES: Record<AtlasToastVariant, {
  icon: ReactNode;
  accent: string;
  border: string;
  iconBackground: string;
  iconBorder: string;
  text: string;
}> = {
  info: {
    icon: 'i',
    accent: 'var(--accent-blue)',
    border: 'rgba(var(--accent-blue-rgb), 0.22)',
    iconBackground: 'linear-gradient(180deg, rgba(var(--accent-blue-rgb), 0.24) 0%, rgba(var(--accent-blue-rgb), 0.12) 100%)',
    iconBorder: 'rgba(var(--accent-blue-rgb), 0.3)',
    text: 'var(--text-secondary-bright)',
  },
  success: {
    icon: '✓',
    accent: 'var(--accent-green)',
    border: 'rgba(var(--accent-green-rgb), 0.24)',
    iconBackground: 'linear-gradient(180deg, rgba(var(--accent-green-rgb), 0.24) 0%, rgba(var(--accent-green-rgb), 0.12) 100%)',
    iconBorder: 'rgba(var(--accent-green-rgb), 0.3)',
    text: 'var(--text-secondary-bright)',
  },
  error: {
    icon: '!',
    accent: 'var(--accent-red)',
    border: 'rgba(var(--accent-red-rgb), 0.26)',
    iconBackground: 'linear-gradient(180deg, rgba(var(--accent-red-rgb), 0.24) 0%, rgba(var(--accent-red-rgb), 0.12) 100%)',
    iconBorder: 'rgba(var(--accent-red-rgb), 0.34)',
    text: 'var(--text-secondary-bright)',
  },
};

function AtlasToastCard({
  variant,
  title,
  description,
  icon,
  dismissible,
  onDismiss,
}: {
  variant: AtlasToastVariant;
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  dismissible: boolean;
  onDismiss: () => void;
}) {
  const theme = VARIANT_STYLES[variant];

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 'var(--space-3)',
        width: 'min(420px, calc(100vw - 32px))',
        padding: description ? '14px 16px' : '12px 14px',
        borderRadius: '14px',
        border: `1px solid ${theme.border}`,
        background: 'linear-gradient(180deg, rgba(18, 26, 40, 0.98) 0%, rgba(13, 19, 31, 0.98) 100%)',
        boxShadow: '0 20px 42px rgba(2, 6, 12, 0.48), inset 0 1px 0 rgba(255, 255, 255, 0.03)',
        color: 'var(--text-primary)',
        backdropFilter: 'blur(14px)',
      }}
    >
      <div
        aria-hidden="true"
        style={{
          width: 28,
          height: 28,
          flexShrink: 0,
          display: 'grid',
          placeItems: 'center',
          borderRadius: '10px',
          background: theme.iconBackground,
          border: `1px solid ${theme.iconBorder}`,
          color: theme.accent,
          fontSize: '15px',
          fontWeight: 700,
          lineHeight: 1,
          boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.08)',
        }}
      >
        {icon ?? theme.icon}
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          style={{
            fontSize: '13px',
            fontWeight: 600,
            lineHeight: 1.3,
            color: 'var(--text-primary)',
            letterSpacing: '-0.01em',
            whiteSpace: 'pre-line',
          }}
        >
          {title}
        </div>
        {description ? (
          <div
            style={{
              marginTop: 4,
              fontSize: '12px',
              lineHeight: 1.45,
              color: theme.text,
              whiteSpace: 'pre-line',
            }}
          >
            {description}
          </div>
        ) : null}
      </div>
      {dismissible ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss notification"
          style={{
            width: 24,
            height: 24,
            flexShrink: 0,
            display: 'grid',
            placeItems: 'center',
            padding: 0,
            borderRadius: '9999px',
            border: '1px solid transparent',
            background: 'transparent',
            color: 'var(--text-tertiary)',
            cursor: 'pointer',
            transition: 'color var(--transition-fast), background var(--transition-fast), border-color var(--transition-fast)',
          }}
        >
          ×
        </button>
      ) : null}
    </div>
  );
}

function showVariant(
  variant: AtlasToastVariant,
  title: ReactNode,
  options?: AtlasToastOptions,
) {
  return hotToast.custom((toastInstance) => (
    <AtlasToastCard
      variant={variant}
      title={title}
      description={options?.description}
      icon={options?.icon}
      dismissible={options?.dismissible ?? true}
      onDismiss={() => hotToast.remove(toastInstance.id)}
    />
  ), {
    id: options?.id,
    duration: options?.duration ?? (variant === 'error' ? 4000 : 3200),
    position: options?.position ?? 'top-right',
  });
}

const toast = Object.assign(
  (title: ReactNode, options?: AtlasToastOptions) => showVariant('info', title, options),
  {
    info: (title: ReactNode, options?: AtlasToastOptions) => showVariant('info', title, options),
    success: (title: ReactNode, options?: AtlasToastOptions) => showVariant('success', title, options),
    error: (title: ReactNode, options?: AtlasToastOptions) => showVariant('error', title, options),
    custom: hotToast.custom,
    dismiss: hotToast.dismiss,
    remove: hotToast.remove,
    loading: hotToast.loading,
    promise: hotToast.promise,
  }
);

export function Toaster() {
  return (
    <HotToaster
      position="top-right"
      gutter={10}
      containerStyle={{ top: 16, right: 16 }}
      toastOptions={{
        duration: 3200,
      }}
    />
  );
}

export type { AtlasToastOptions };
export default toast;
