/**
 * LemonSqueezy checkout service.
 *
 * Handles the overlay checkout flow in the Tauri desktop app.
 * Listens for checkout success events and resolves pending promises.
 */

declare global {
  interface Window {
    LemonSqueezy?: {
      Setup: (config: { eventHandler: (event: LemonEvent) => void }) => void;
      Url: {
        Open: (url: string) => void;
        Close: () => void;
      };
      Refresh: () => void;
    };
  }
}

interface LemonEvent {
  event: string;
  data?: {
    order_number?: string;
    [key: string]: unknown;
  };
}

type CheckoutResolver = {
  resolve: (orderNumber: string) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

let _initialized = false;
let _pendingCheckout: CheckoutResolver | null = null;

const CHECKOUT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Initialize the LemonSqueezy event handler.
 * Call once on app startup (after Lemon.js loads).
 */
export function initialize(): void {
  if (_initialized) return;

  if (!window.LemonSqueezy) {
    console.warn('[Checkout] LemonSqueezy SDK not loaded — checkout will not work');
    return;
  }

  window.LemonSqueezy.Setup({
    eventHandler: (event: LemonEvent) => {
      if (event.event === 'Checkout.Success' && _pendingCheckout) {
        const orderNumber = event.data?.order_number || 'unknown';
        clearTimeout(_pendingCheckout.timeoutId);
        _pendingCheckout.resolve(orderNumber);
        _pendingCheckout = null;
      }

      if (event.event === 'Checkout.Close' && _pendingCheckout) {
        // User closed the overlay without completing — don't reject immediately,
        // they might reopen. The timeout will handle truly abandoned checkouts.
      }
    },
  });

  _initialized = true;
  console.log('[Checkout] LemonSqueezy event handler initialized');
}

/**
 * Open a LemonSqueezy checkout overlay and wait for success.
 *
 * @param url The checkout URL returned by /api/deploy/init
 * @returns The order number on success
 * @throws If checkout times out or is explicitly cancelled
 */
export function openCheckout(url: string): Promise<string> {
  if (!window.LemonSqueezy) {
    return Promise.reject(new Error('LemonSqueezy SDK not loaded'));
  }

  // Cancel any existing pending checkout
  if (_pendingCheckout) {
    clearTimeout(_pendingCheckout.timeoutId);
    _pendingCheckout.reject(new Error('Checkout superseded by new checkout'));
    _pendingCheckout = null;
  }

  return new Promise<string>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      _pendingCheckout = null;
      reject(new Error('Checkout timed out'));
    }, CHECKOUT_TIMEOUT_MS);

    _pendingCheckout = { resolve, reject, timeoutId };
    window.LemonSqueezy!.Url.Open(url);
  });
}

/**
 * Cancel any pending checkout.
 */
export function cancelCheckout(): void {
  if (_pendingCheckout) {
    clearTimeout(_pendingCheckout.timeoutId);
    _pendingCheckout.reject(new Error('Checkout cancelled'));
    _pendingCheckout = null;
  }
  window.LemonSqueezy?.Url.Close();
}

/**
 * Check if the checkout service is initialized.
 */
export function isInitialized(): boolean {
  return _initialized;
}
