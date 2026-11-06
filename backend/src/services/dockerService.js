/**
 * Docker Service
 * Manages Docker containers with security hardening
 *
 * Key Security Features:
 * - Builder/Runner separation
 * - Non-root containers
 * - Read-only filesystems
 * - Network isolation
 * - Resource limits
 * - Capability dropping
 */

import Docker from 'dockerode';
import path from 'path';
import fs from 'fs/promises';
import {
  createBuild,
  updateBuildStatus,
  createPreview,
  updatePreviewStatus,
  stopPreview as stopPreviewDb,
  logEvent
} from '../db/queries.js';
import portRegistry from './portRegistry.js';

class DockerService {
  constructor() {
    // Defer Docker client creation — env vars may not be loaded yet at import
    // time (ES module imports run before dotenv.config in server.js).
    this._docker = null;

    // Config defaults — safe to set eagerly (no env-var dependency).
    // Env-var overrides are applied in the lazy docker getter below.
    this.dockerNetwork = 'atlasengine-internal';
    this.defaultMemoryLimit = '256m';
    this.defaultCpuLimit = 0.25;
    this.builderImage = 'node:20-alpine';
    this.builderMemoryLimit = 512 * 1024 * 1024; // 512MB
    this.builderCpuQuota = 50000; // 0.5 CPU

    console.log('✅ Docker Service initialized');
  }

  /** Lazily create the Docker client so process.env is populated by dotenv */
  get docker() {
    if (!this._docker) {
      const defaultSocket = process.platform === 'win32'
        ? '//./pipe/docker_engine'
        : '/var/run/docker.sock';
      this._docker = new Docker({
        socketPath: process.env.DOCKER_SOCKET || defaultSocket
      });
      // Override defaults with env vars now that dotenv has loaded
      this.dockerNetwork = process.env.DOCKER_NETWORK || this.dockerNetwork;
      this.defaultMemoryLimit = process.env.DEFAULT_CONTAINER_MEMORY || this.defaultMemoryLimit;
      this.defaultCpuLimit = parseFloat(process.env.DEFAULT_CONTAINER_CPU || this.defaultCpuLimit);
    }
    return this._docker;
  }

  /**
   * Initialize Docker network for container isolation
   * @returns {Promise<void>}
   */
  async initializeNetwork() {
    try {
      // Check if network exists
      const networks = await this.docker.listNetworks();
      const networkExists = networks.some(n => n.Name === this.dockerNetwork);

      if (networkExists) {
        console.log(`✅ Docker network '${this.dockerNetwork}' already exists`);
        return;
      }

      // Create network
      await this.docker.createNetwork({
        Name: this.dockerNetwork,
        Driver: 'bridge',
        Internal: false, // Allow external access for deployments
        EnableIPv6: false,
        Labels: {
          'app': 'atlasengine',
          'purpose': 'container-isolation'
        }
      });

      console.log(`✅ Created Docker network '${this.dockerNetwork}'`);
    } catch (error) {
      console.error('Error initializing Docker network:', error);
      throw error;
    }
  }

  /**
   * Build project in isolated builder container
   * Phase 1: Untrusted build environment
   *
   * @param {string} projectId - Project UUID
   * @param {string} projectPath - Filesystem path to project
   * @param {string} userId - User UUID
   * @returns {Promise<Object>} Build result
   */
  async buildProject(projectId, projectPath, userId) {
    let buildRecord = null;

    try {
      // Create build record
      buildRecord = await createBuild({
        projectId,
        userId,
        status: 'queued'
      });

      console.log(`🔨 Starting build for project ${projectId} (build ${buildRecord.id})`);

      // Log build started event
      await logEvent({
        userId,
        projectId,
        kind: 'build_started',
        status: 'info',
        message: `Build ${buildRecord.id} started`,
        meta: { buildId: buildRecord.id }
      });

      // Update build status to running
      await updateBuildStatus(buildRecord.id, 'running');

      // Check if package.json exists
      const packageJsonPath = path.join(projectPath, 'package.json');
      try {
        await fs.access(packageJsonPath);
      } catch (error) {
        throw new Error('package.json not found in project directory');
      }

      // Create builder container with restrictions
      const builderConfig = {
        Image: this.builderImage,
        Cmd: ['sh', '-c', 'cd /workspace && npm ci && npm run build'],
        HostConfig: {
          Binds: [`${projectPath}:/workspace:rw`],
          NetworkMode: 'none', // No network during build (security)
          CapDrop: ['ALL'], // Drop all capabilities
          SecurityOpt: ['no-new-privileges'],
          Memory: this.builderMemoryLimit,
          CpuQuota: this.builderCpuQuota,
          ReadonlyRootfs: false, // Builder needs write access for node_modules
          AutoRemove: true // Auto-cleanup after build
        },
        Labels: {
          'app': 'atlasengine',
          'purpose': 'builder',
          'project-id': projectId,
          'build-id': buildRecord.id
        }
      };

      console.log('Creating builder container...');
      const builder = await this.docker.createContainer(builderConfig);

      // Update build record with container ID
      await updateBuildStatus(buildRecord.id, 'running', {
        builderContainerId: builder.id
      });

      // Start builder
      await builder.start();
      console.log('✅ Builder container started');

      // Wait for build to complete
      const result = await builder.wait();

      // Get build logs
      const logs = await builder.logs({
        stdout: true,
        stderr: true,
        timestamps: true
      });

      const buildLogs = logs.toString('utf8');

      if (result.StatusCode === 0) {
        // Build succeeded
        console.log(`✅ Build succeeded for project ${projectId}`);

        await updateBuildStatus(buildRecord.id, 'succeeded', {
          buildLogs
        });

        await logEvent({
          userId,
          projectId,
          kind: 'build_succeeded',
          status: 'success',
          message: `Build ${buildRecord.id} completed successfully`,
          meta: { buildId: buildRecord.id }
        });

        return {
          success: true,
          buildId: buildRecord.id,
          logs: buildLogs
        };
      } else {
        // Build failed
        console.log(`❌ Build failed for project ${projectId} (exit code: ${result.StatusCode})`);

        await updateBuildStatus(buildRecord.id, 'failed', {
          buildLogs,
          errorMessage: `Build failed with exit code ${result.StatusCode}`
        });

        await logEvent({
          userId,
          projectId,
          kind: 'build_failed',
          status: 'failure',
          message: `Build ${buildRecord.id} failed`,
          meta: { buildId: buildRecord.id, exitCode: result.StatusCode }
        });

        return {
          success: false,
          buildId: buildRecord.id,
          error: `Build failed with exit code ${result.StatusCode}`,
          logs: buildLogs
        };
      }
    } catch (error) {
      console.error('Build error:', error);

      if (buildRecord) {
        await updateBuildStatus(buildRecord.id, 'failed', {
          errorMessage: error.message
        });

        await logEvent({
          userId,
          projectId,
          kind: 'build_failed',
          status: 'failure',
          message: `Build ${buildRecord.id} failed with error`,
          meta: { buildId: buildRecord.id, error: error.message }
        });
      }

      throw error;
    }
  }

  /**
   * Deploy project in hardened runner container
   * Phase 2: Production runtime environment
   *
   * @param {string} projectId - Project UUID
   * @param {string} projectPath - Filesystem path to project
   * @param {string} userId - User UUID
   * @param {string} buildId - Build UUID
   * @returns {Promise<Object>} Deployment result
   */
  async deployProject(projectId, projectPath, userId, buildId) {
    try {
      console.log(`🚀 Deploying project ${projectId}`);

      // Allocate port
      const port = portRegistry.allocatePort(projectId);

      // Generate container name
      const containerName = `atlasengine-${projectId.substring(0, 8)}-${Date.now()}`;

      // Generate host
      const host = `proj-${projectId.substring(0, 8)}.${process.env.DOMAIN || 'localhost'}`;

      // Create hardened runner container
      const runnerConfig = {
        name: containerName,
        Image: 'node:20-alpine',
        Cmd: ['sh', '-c', 'cd /app && npm start'],
        User: '1000:1000', // Non-root user
        WorkingDir: '/app',
        ExposedPorts: {
          '3000/tcp': {}
        },
        HostConfig: {
          Binds: [`${projectPath}:/app:ro`], // Read-only mount
          PortBindings: {
            '3000/tcp': [{ HostPort: port.toString() }]
          },
          NetworkMode: this.dockerNetwork,
          ReadonlyRootfs: true, // Immutable filesystem
          Tmpfs: {
            '/tmp': 'rw,noexec,nosuid,size=100m'
          },
          CapDrop: ['ALL'], // Drop all capabilities
          SecurityOpt: [
            'no-new-privileges',
            'seccomp=runtime/default'
          ],
          Memory: this.parseMemoryLimit(this.defaultMemoryLimit),
          NanoCpus: this.defaultCpuLimit * 1e9,
          RestartPolicy: {
            Name: 'on-failure',
            MaximumRetryCount: 3
          }
        },
        Labels: {
          'app': 'atlasengine',
          'purpose': 'runner',
          'project-id': projectId,
          'build-id': buildId
        }
      };

      console.log('Creating runner container...');
      const container = await this.docker.createContainer(runnerConfig);

      // Create preview record
      const preview = await createPreview({
        projectId,
        buildId,
        userId,
        containerId: container.id,
        containerName,
        host,
        port,
        imageId: runnerConfig.Image
      });

      // Start container
      await container.start();
      console.log(`✅ Runner container started: ${containerName}`);

      // Wait for health check
      console.log('🔍 Waiting for health check...');
      const healthCheck = await portRegistry.healthCheck(port, {
        maxAttempts: 15,
        intervalMs: 2000
      });

      if (healthCheck.healthy) {
        // Update preview status to healthy
        await updatePreviewStatus(preview.id, 'healthy');

        await logEvent({
          userId,
          projectId,
          kind: 'deploy_succeeded',
          status: 'success',
          message: `Project deployed successfully on port ${port}`,
          meta: {
            previewId: preview.id,
            containerId: container.id,
            port,
            host
          }
        });

        console.log(`✅ Deployment successful: http://localhost:${port}`);

        return {
          success: true,
          previewId: preview.id,
          containerId: container.id,
          containerName,
          port,
          host,
          url: `http://localhost:${port}`
        };
      } else {
        // Health check failed - stop container
        await container.stop();
        await container.remove();
        portRegistry.releasePort(projectId);

        await updatePreviewStatus(preview.id, 'failed');

        await logEvent({
          userId,
          projectId,
          kind: 'deploy_failed',
          status: 'failure',
          message: 'Deployment failed health check',
          meta: { previewId: preview.id, reason: 'Health check failed' }
        });

        throw new Error('Container failed health check');
      }
    } catch (error) {
      console.error('Deployment error:', error);

      // Release port if allocated
      portRegistry.releasePort(projectId);

      throw error;
    }
  }

  /**
   * Stop and remove a preview container
   * @param {string} previewId - Preview UUID
   * @param {string} containerId - Container ID
   * @param {string} projectId - Project UUID
   * @returns {Promise<void>}
   */
  async stopContainer(previewId, containerId, projectId) {
    try {
      console.log(`🛑 Stopping container ${containerId}`);

      const container = this.docker.getContainer(containerId);

      // Stop container
      await container.stop({ t: 10 }); // 10 second grace period

      // Remove container
      await container.remove();

      // Release port
      portRegistry.releasePort(projectId);

      // Update preview status
      await stopPreviewDb(previewId);

      console.log(`✅ Container ${containerId} stopped and removed`);
    } catch (error) {
      console.error('Error stopping container:', error);
      throw error;
    }
  }

  /**
   * Get container logs
   * @param {string} containerId - Container ID
   * @param {Object} options - Log options
   * @returns {Promise<string>} Container logs
   */
  async getContainerLogs(containerId, options = {}) {
    try {
      const container = this.docker.getContainer(containerId);

      const logs = await container.logs({
        stdout: true,
        stderr: true,
        timestamps: true,
        tail: options.tail || 100,
        ...options
      });

      return logs.toString('utf8');
    } catch (error) {
      console.error('Error getting container logs:', error);
      throw error;
    }
  }

  /**
   * Get container stats
   * @param {string} containerId - Container ID
   * @returns {Promise<Object>} Container stats
   */
  async getContainerStats(containerId) {
    try {
      const container = this.docker.getContainer(containerId);
      const stats = await container.stats({ stream: false });

      return {
        memoryUsage: stats.memory_stats.usage,
        memoryLimit: stats.memory_stats.limit,
        cpuUsage: stats.cpu_stats.cpu_usage.total_usage,
        networkRx: stats.networks?.eth0?.rx_bytes || 0,
        networkTx: stats.networks?.eth0?.tx_bytes || 0
      };
    } catch (error) {
      console.error('Error getting container stats:', error);
      throw error;
    }
  }

  /**
   * List all running containers
   * @returns {Promise<Array>} Running containers
   */
  async listContainers() {
    try {
      const containers = await this.docker.listContainers({
        filters: {
          label: ['app=atlasengine']
        }
      });

      return containers.map(c => ({
        id: c.Id,
        name: c.Names[0].replace('/', ''),
        image: c.Image,
        state: c.State,
        status: c.Status,
        ports: c.Ports,
        labels: c.Labels,
        created: c.Created
      }));
    } catch (error) {
      console.error('Error listing containers:', error);
      throw error;
    }
  }

  /**
   * Clean up stopped containers
   * @returns {Promise<number>} Number of containers cleaned up
   */
  async cleanupStoppedContainers() {
    try {
      console.log('🧹 Cleaning up stopped containers...');

      const containers = await this.docker.listContainers({
        all: true,
        filters: {
          label: ['app=atlasengine'],
          status: ['exited', 'dead']
        }
      });

      for (const containerInfo of containers) {
        try {
          const container = this.docker.getContainer(containerInfo.Id);
          await container.remove();
          console.log(`Removed stopped container ${containerInfo.Id}`);
        } catch (error) {
          console.error(`Error removing container ${containerInfo.Id}:`, error.message);
        }
      }

      console.log(`✅ Cleaned up ${containers.length} stopped containers`);

      return containers.length;
    } catch (error) {
      console.error('Error cleaning up containers:', error);
      throw error;
    }
  }

  /**
   * Parse memory limit string to bytes
   * @param {string} limit - Memory limit (e.g., "256m", "1g")
   * @returns {number} Memory limit in bytes
   */
  parseMemoryLimit(limit) {
    const units = {
      'k': 1024,
      'm': 1024 * 1024,
      'g': 1024 * 1024 * 1024
    };

    const match = limit.match(/^(\d+)([kmg])$/i);
    if (!match) {
      throw new Error(`Invalid memory limit format: ${limit}`);
    }

    const value = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();

    return value * units[unit];
  }

  /**
   * Health check for Docker daemon
   * @returns {Promise<Object>} Health status
   */
  async healthCheck() {
    try {
      await this.docker.ping();

      const info = await this.docker.info();

      return {
        healthy: true,
        version: info.ServerVersion,
        containers: info.Containers,
        containersRunning: info.ContainersRunning,
        containersPaused: info.ContainersPaused,
        containersStopped: info.ContainersStopped,
        images: info.Images
      };
    } catch (error) {
      return {
        healthy: false,
        error: error.message
      };
    }
  }
}

// Export singleton instance
const dockerService = new DockerService();

export default dockerService;
