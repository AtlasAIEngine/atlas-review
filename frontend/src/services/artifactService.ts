/**
 * Artifact service — packages a project from the local backend
 * and uploads it to the cloud backend's R2 storage.
 */

import { projectApi } from './api';

/**
 * Download a project archive from the local backend.
 * Returns the archive as an ArrayBuffer.
 */
export async function fetchProjectArchive(
  projectId: string,
  commitHash?: string
): Promise<ArrayBuffer> {
  const params = commitHash ? `?commit=${encodeURIComponent(commitHash)}` : '';
  const response = await projectApi.getArchive(projectId, params);
  return response;
}

/**
 * Upload an archive to a pre-signed R2 URL.
 *
 * @param uploadUrl Pre-signed PUT URL from /api/deploy/push
 * @param archiveData The tar.gz archive as ArrayBuffer
 * @param onProgress Optional progress callback (0-100)
 */
export async function uploadArtifact(
  uploadUrl: string,
  archiveData: ArrayBuffer,
  onProgress?: (percent: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl);
    xhr.setRequestHeader('Content-Type', 'application/gzip');

    if (onProgress) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          onProgress(Math.round((event.loaded / event.total) * 100));
        }
      };
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(`Upload failed with status ${xhr.status}`));
      }
    };

    xhr.onerror = () => reject(new Error('Upload network error'));
    xhr.ontimeout = () => reject(new Error('Upload timeout'));
    xhr.timeout = 5 * 60 * 1000; // 5 minutes

    xhr.send(archiveData);
  });
}
