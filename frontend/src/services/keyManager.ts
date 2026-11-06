/**
 * Device keypair management for cloud deployments.
 *
 * Generates an Ed25519 keypair on first launch, stores it in the OS keychain
 * via tauri-plugin-keyring. Falls back to localStorage in browser dev mode.
 *
 * The deviceId is the SHA-256 hex digest of the public key's SPKI bytes.
 */

import { generateKeyPair, exportJWK, importJWK, exportSPKI } from 'jose';
import { isTauriEnvironment } from '@/utils/tauri';

const KEYCHAIN_SERVICE = 'com.atlasengine.desktop';
const KEYCHAIN_PRIVATE_KEY = 'device-private-key';
const KEYCHAIN_PUBLIC_KEY = 'device-public-key';
const LOCALSTORAGE_PRIVATE_KEY = 'atlas_device_private_jwk';
const LOCALSTORAGE_PUBLIC_KEY = 'atlas_device_public_jwk';

let _privateKey: CryptoKey | null = null;
let _publicKey: CryptoKey | null = null;
let _deviceId: string | null = null;
let _initialized = false;
let _initPromise: Promise<void> | null = null;

// ---------- Tauri keyring bridge ----------

async function isTauri(): Promise<boolean> {
  try {
    return isTauriEnvironment();
  } catch {
    return false;
  }
}

async function keychainGet(key: string): Promise<string | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const value: string = await invoke('plugin:keyring|get', {
      service: KEYCHAIN_SERVICE,
      name: key,
    });
    return value || null;
  } catch {
    return null;
  }
}

async function keychainSet(key: string, value: string): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('plugin:keyring|set', {
    service: KEYCHAIN_SERVICE,
    name: key,
    value,
  });
}

// ---------- Key storage (keychain or localStorage fallback) ----------

async function loadStoredKeys(): Promise<{ privateJwk: object; publicJwk: object } | null> {
  if (await isTauri()) {
    const privStr = await keychainGet(KEYCHAIN_PRIVATE_KEY);
    const pubStr = await keychainGet(KEYCHAIN_PUBLIC_KEY);
    if (privStr && pubStr) {
      return { privateJwk: JSON.parse(privStr), publicJwk: JSON.parse(pubStr) };
    }
    return null;
  }

  // Fallback: localStorage (dev mode)
  const privStr = localStorage.getItem(LOCALSTORAGE_PRIVATE_KEY);
  const pubStr = localStorage.getItem(LOCALSTORAGE_PUBLIC_KEY);
  if (privStr && pubStr) {
    console.warn('[KeyManager] Using localStorage fallback — keys are NOT secure');
    return { privateJwk: JSON.parse(privStr), publicJwk: JSON.parse(pubStr) };
  }
  return null;
}

async function storeKeys(privateJwk: object, publicJwk: object): Promise<void> {
  if (await isTauri()) {
    await keychainSet(KEYCHAIN_PRIVATE_KEY, JSON.stringify(privateJwk));
    await keychainSet(KEYCHAIN_PUBLIC_KEY, JSON.stringify(publicJwk));
    return;
  }

  // Fallback: localStorage (dev mode)
  console.warn('[KeyManager] Storing keys in localStorage — NOT secure for production');
  localStorage.setItem(LOCALSTORAGE_PRIVATE_KEY, JSON.stringify(privateJwk));
  localStorage.setItem(LOCALSTORAGE_PUBLIC_KEY, JSON.stringify(publicJwk));
}

// ---------- Device ID computation ----------

async function computeDeviceId(publicKey: CryptoKey): Promise<string> {
  // Export as SPKI PEM, extract the base64 body, decode to bytes, SHA-256
  const spkiPem = await exportSPKI(publicKey);
  const base64Body = spkiPem
    .replace(/-----BEGIN PUBLIC KEY-----/, '')
    .replace(/-----END PUBLIC KEY-----/, '')
    .replace(/\s/g, '');
  const spkiBytes = Uint8Array.from(atob(base64Body), c => c.charCodeAt(0));
  const hashBuffer = await crypto.subtle.digest('SHA-256', spkiBytes);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---------- Public API ----------

/**
 * Initialize the key manager. Loads existing keypair from keychain/storage,
 * or generates a new Ed25519 keypair on first launch.
 *
 * Uses a deduplicating promise to prevent concurrent callers from generating
 * multiple keypairs (race condition between App.tsx and PublishDialog).
 */
export function initialize(): Promise<void> {
  if (_initialized) return Promise.resolve();
  if (_initPromise) return _initPromise;
  _initPromise = doInitialize().finally(() => { _initPromise = null; });
  return _initPromise;
}

async function doInitialize(): Promise<void> {
  const stored = await loadStoredKeys();
  if (stored) {
    _privateKey = await importJWK(stored.privateJwk as any, 'EdDSA') as CryptoKey;
    _publicKey = await importJWK(stored.publicJwk as any, 'EdDSA') as CryptoKey;
  } else {
    const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    _privateKey = privateKey as CryptoKey;
    _publicKey = publicKey as CryptoKey;

    const privateJwk = await exportJWK(privateKey);
    const publicJwk = await exportJWK(publicKey);
    // Ensure ext=true so importJWK recreates extractable keys in browser WebCrypto
    (privateJwk as any).ext = true;
    (publicJwk as any).ext = true;
    await storeKeys(privateJwk, publicJwk);
  }

  _deviceId = await computeDeviceId(_publicKey!);
  _initialized = true;
  console.log(`[KeyManager] Initialized. Device ID: ${_deviceId.substring(0, 12)}...`);
}

/**
 * Get the device's private key for signing DPoP proofs.
 */
export function getPrivateKey(): CryptoKey {
  if (!_privateKey) throw new Error('KeyManager not initialized');
  return _privateKey;
}

/**
 * Get the device's public key.
 */
export function getPublicKey(): CryptoKey {
  if (!_publicKey) throw new Error('KeyManager not initialized');
  return _publicKey;
}

/**
 * Get the device ID (SHA-256 hex of public key SPKI bytes).
 */
export function getDeviceId(): string {
  if (!_deviceId) throw new Error('KeyManager not initialized');
  return _deviceId;
}

/**
 * Get the public key in JWK format (for DPoP header).
 */
export async function getPublicKeyJwk(): Promise<object> {
  if (!_publicKey) throw new Error('KeyManager not initialized');
  return exportJWK(_publicKey);
}

/**
 * Check if the key manager has been initialized.
 */
export function isInitialized(): boolean {
  return _initialized;
}
