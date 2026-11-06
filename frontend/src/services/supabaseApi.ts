/**
 * Supabase API Client
 * Service for interacting with Supabase integration endpoints (PAT-based auth)
 */

import axios from 'axios';
import { getApiBaseUrl } from './api';

const api = axios.create({
  baseURL: getApiBaseUrl(),
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.request.use((config) => {
  config.baseURL = getApiBaseUrl();
  const token = localStorage.getItem('auth_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export interface SupabaseStatus {
  connected: boolean;
  email?: string | null;
  organizations?: Array<{ id: string; name: string }>;
}

export interface SupabaseOrganization {
  id: string;
  name: string;
}

export interface SupabaseProject {
  id: string;
  name: string;
  organization_id: string;
  region: string;
  status: string;
  created_at: string;
}

export interface SupabaseLinkedProject {
  id: string;
  project_id: string;
  supabase_project_ref: string;
  supabase_project_name: string;
  supabase_org_id: string | null;
  region: string | null;
  anon_key: string | null;
  supabase_url: string;
  provisioned_by: string;
  created_at: string;
  updated_at: string;
}

export const supabaseApi = {
  async getStatus(): Promise<SupabaseStatus> {
    const res = await api.get('/supabase/status');
    return res.data;
  },

  async connect(accessToken: string): Promise<{ success: boolean }> {
    const res = await api.post('/supabase/connect', { accessToken });
    return res.data;
  },

  async disconnect(): Promise<void> {
    await api.post('/supabase/disconnect');
  },

  async getOrganizations(): Promise<SupabaseOrganization[]> {
    const res = await api.get('/supabase/organizations');
    return res.data.organizations;
  },

  async getProjects(orgId?: string): Promise<SupabaseProject[]> {
    const params = orgId ? { orgId } : {};
    const res = await api.get('/supabase/projects', { params });
    return res.data.projects;
  },

  async linkProject(
    projectId: string,
    data: { supabaseProjectRef?: string; create?: boolean; organizationId?: string; region?: string; projectName?: string }
  ): Promise<{ linked: SupabaseLinkedProject }> {
    const res = await api.post(`/supabase/projects/${projectId}/link`, data);
    return res.data;
  },

  async unlinkProject(projectId: string, removeSecrets = false): Promise<void> {
    await api.post(`/supabase/projects/${projectId}/unlink`, { removeSecrets });
  },

  async deleteDatabase(projectId: string, confirmName: string): Promise<void> {
    await api.delete(`/supabase/projects/${projectId}/database`, { data: { confirmName } });
  },

  async getLinkedProject(projectId: string): Promise<SupabaseLinkedProject | null> {
    const res = await api.get(`/supabase/projects/${projectId}/link`);
    return res.data.linked || null;
  },
};

export default supabaseApi;
