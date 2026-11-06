/**
 * Cloud Deploy API client.
 *
 * Separate Axios instance for the cloud backend at api.atlasengine.dev.
 * Automatically attaches DPoP proofs to every request.
 */

import axios, { type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';
import { createDPoPProof } from './dpopService';

const CLOUD_API_URL = import.meta.env.VITE_CLOUD_API_URL || 'https://api.atlasengine.dev';

const cloudHealthApi: AxiosInstance = axios.create({
  baseURL: CLOUD_API_URL,
  headers: { 'Content-Type': 'application/json' },
  timeout: 10000,
});

const cloudApi: AxiosInstance = axios.create({
  baseURL: `${CLOUD_API_URL}/api/deploy`,
  headers: { 'Content-Type': 'application/json' },
  timeout: 30000,
});

// Request interceptor: attach DPoP proof header
cloudApi.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
  const method = (config.method || 'GET').toUpperCase();
  const fullUrl = `${config.baseURL || ''}${config.url || ''}`;

  try {
    const dpopProof = await createDPoPProof(method, fullUrl);
    config.headers.set('DPoP', dpopProof);
  } catch (err) {
    console.error('[DeployAPI] Failed to create DPoP proof:', err);
    // Let the request proceed — server will reject with 401 if DPoP is required
  }

  return config;
});

// ---------- Types ----------

export interface CloudConfig {
  paymentsEnabled: boolean;
}

export interface InitResponse {
  success: boolean;
  data: {
    deviceId: string;
    checkoutUrl?: string;   // Present for paid tier
    freeToken?: string;     // Present for free tier
    bypassToken?: string;   // Present when payments disabled
    message?: string;
  };
}

export interface ActivateResponse {
  success: boolean;
  data: {
    instanceId: string;
    activated: boolean;
  };
}

export interface OrderStatusResponse {
  success: boolean;
  data: {
    ready: boolean;
    licenseId?: number;
  };
}

export interface PushResponse {
  success: boolean;
  data: {
    deploymentId: number;
    uploadUrl: string;      // Pre-signed R2 PUT URL
  };
}

export interface FinalizeResponse {
  success: boolean;
  data: {
    deploymentId: number;
    status: string;
  };
}

export interface DeploymentStatus {
  success: boolean;
  data: {
    id: number;
    projectName: string;
    subdomain: string;
    tier: string;
    status: string;
    liveUrl: string | null;
    buildLog: string | null;
    expiresAt: string | null;
    createdAt: string;
    updatedAt: string;
  };
}

export interface DeploymentListItem {
  id: number;
  projectName: string;
  subdomain: string;
  tier: string;
  status: string;
  liveUrl: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface DeploymentListResponse {
  success: boolean;
  data: DeploymentListItem[];
}

// ---------- API methods ----------

/**
 * Initialize deployment: register device, get checkout URL (paid) or free token.
 */
export async function init(projectName: string, tier: 'free' | 'paid'): Promise<InitResponse> {
  const { data } = await cloudApi.post<InitResponse>('/init', { projectName, tier });
  return data;
}

/**
 * Activate a license key after LemonSqueezy payment.
 */
export async function activate(licenseKey: string): Promise<ActivateResponse> {
  const { data } = await cloudApi.post<ActivateResponse>('/activate', { licenseKey });
  return data;
}

/**
 * Request a pre-signed upload URL for the project artifact.
 */
export async function push(params: {
  projectName: string;
  licenseKey?: string;
  freeToken?: string;
  orderId?: string;
}): Promise<PushResponse> {
  const { data } = await cloudApi.post<PushResponse>('/push', params);
  return data;
}

/**
 * Check if a LemonSqueezy order's webhook has been processed (license ready).
 */
export async function getOrderStatus(orderId: string): Promise<OrderStatusResponse> {
  const { data } = await cloudApi.get<OrderStatusResponse>(`/order-status/${orderId}`);
  return data;
}

/**
 * Trigger build after artifact upload is complete.
 */
export async function finalize(deploymentId: number): Promise<FinalizeResponse> {
  const { data } = await cloudApi.post<FinalizeResponse>('/finalize', { deploymentId });
  return data;
}

/**
 * Get deployment status and build log.
 */
export async function getStatus(deploymentId: number): Promise<DeploymentStatus> {
  const { data } = await cloudApi.get<DeploymentStatus>(`/status/${deploymentId}`);
  return data;
}

/**
 * List all deployments for this device.
 */
export async function list(): Promise<DeploymentListResponse> {
  const { data } = await cloudApi.get<DeploymentListResponse>('/list');
  return data;
}

/**
 * Get cloud backend config (payments enabled, etc.) from the health endpoint.
 */
export async function getConfig(): Promise<CloudConfig> {
  const { data } = await cloudHealthApi.get('/health');
  return { paymentsEnabled: data.paymentsEnabled ?? true };
}
