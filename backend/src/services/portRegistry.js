/**
 * Port Registry Service
 * Manages port allocation and health checks for preview containers
 *
 * Features:
 * - Port pool management (3001-3100)
 * - Health check with retry logic
 * - Automatic port reclamation
 * - Port availability tracking
 */

import { logEvent } from '../db/queries.js';

class PortRegistry {
  constructor() {
    // Port range configuration (from env or defaults)
    this.portRangeStart = parseInt(process.env.PORT_RANGE_START || '3001', 10);
    this.portRangeEnd = parseInt(process.env.PORT_RANGE_END || '3100', 10);

    // Reserved system ports that should NEVER be allocated to user projects
    // 3000: AtlasEngine backend
    // 5173: AtlasEngine frontend (Vite dev)
    // 5432: PostgreSQL
    // 6379: Redis
    this.reservedPorts = new Set([3000, 5173, 5432, 6379]);

    // Available ports pool (Set for O(1) operations)
    this.portPool = new Set();

    // Active port allocations (projectId -> port)
    this.allocations = new Map();

    // Port -> projectId reverse mapping
    this.portToProject = new Map();

    // Health check configuration
    this.healthCheckMaxAttempts = 10;
    this.healthCheckIntervalMs = 1000;
    this.healthCheckTimeoutMs = 2000;

    // Initialize port pool
    this.initializePool();

    console.log(`✅ Port Registry initialized: ${this.portRangeStart}-${this.portRangeEnd} (${this.portPool.size} ports)`);
    console.log(`🔒 Reserved system ports: ${Array.from(this.reservedPorts).join(', ')}`);
  }

  /**
   * Initialize the port pool (excluding reserved system ports)
   */
  initializePool() {
    for (let port = this.portRangeStart; port <= this.portRangeEnd; port++) {
      // Skip reserved system ports
      if (!this.reservedPorts.has(port)) {
        this.portPool.add(port);
      }
    }
  }

  /**
   * Allocate a port for a project
   * @param {string} projectId - Project UUID
   * @returns {number} Allocated port
   * @throws {Error} If no ports available
   */
  allocatePort(projectId) {
    // Check if project already has a port allocated
    const existingPort = this.allocations.get(projectId);
    if (existingPort) {
      console.log(`Port ${existingPort} already allocated to project ${projectId}`);
      return existingPort;
    }

    // Check if port pool is empty
    if (this.portPool.size === 0) {
      throw new Error('No available ports in pool. All ports are in use.');
    }

    // Get first available port
    const port = this.portPool.values().next().value;

    // Safety check: Never allocate reserved system ports
    if (this.reservedPorts.has(port)) {
      console.error(`❌ CRITICAL: Attempted to allocate reserved port ${port}! Skipping.`);
      this.portPool.delete(port); // Remove from pool permanently
      return this.allocatePort(projectId); // Retry with next port
    }

    // Remove from pool and add to allocations
    this.portPool.delete(port);
    this.allocations.set(projectId, port);
    this.portToProject.set(port, projectId);

    console.log(`✅ Allocated port ${port} to project ${projectId}`);

    return port;
  }

  /**
   * Release a port back to the pool
   * @param {string} projectId - Project UUID
   * @returns {boolean} True if port was released
   */
  releasePort(projectId) {
    const port = this.allocations.get(projectId);

    if (!port) {
      console.warn(`No port allocated to project ${projectId}`);
      return false;
    }

    // Remove from allocations
    this.allocations.delete(projectId);
    this.portToProject.delete(port);

    // Safety check: Never return reserved system ports to pool
    if (!this.reservedPorts.has(port)) {
      this.portPool.add(port);
    } else {
      console.warn(`⚠️  Prevented reserved port ${port} from being returned to pool`);
    }

    console.log(`✅ Released port ${port} from project ${projectId}`);

    return true;
  }

  /**
   * Reassign an existing project allocation to a different port.
   * Used when a dev server auto-increments to a new port at runtime.
   * @param {string} projectId - Project UUID
   * @param {number} nextPort - Actual port now used by the project
   * @returns {number} The assigned port
   */
  reassignPort(projectId, nextPort) {
    const currentPort = this.allocations.get(projectId);

    if (currentPort === nextPort) {
      return nextPort;
    }

    if (this.reservedPorts.has(nextPort)) {
      throw new Error(`Cannot reassign project ${projectId} to reserved port ${nextPort}`);
    }

    const existingOwner = this.portToProject.get(nextPort);
    if (existingOwner && existingOwner !== projectId) {
      throw new Error(`Port ${nextPort} is already allocated to project ${existingOwner}`);
    }

    if (typeof currentPort === 'number') {
      this.portToProject.delete(currentPort);
      if (!this.reservedPorts.has(currentPort)) {
        this.portPool.add(currentPort);
      }
    }

    this.portPool.delete(nextPort);
    this.allocations.set(projectId, nextPort);
    this.portToProject.set(nextPort, projectId);

    console.log(`✅ Reassigned project ${projectId} port ${currentPort ?? 'none'} → ${nextPort}`);
    return nextPort;
  }

  /**
   * Get port for a project
   * @param {string} projectId - Project UUID
   * @returns {number|null} Port or null if not allocated
   */
  getPort(projectId) {
    return this.allocations.get(projectId) || null;
  }

  /**
   * Get project for a port
   * @param {number} port - Port number
   * @returns {string|null} Project UUID or null
   */
  getProjectByPort(port) {
    return this.portToProject.get(port) || null;
  }

  /**
   * Check if a port is available
   * @param {number} port - Port number
   * @returns {boolean} True if available
   */
  isPortAvailable(port) {
    return this.portPool.has(port);
  }

  /**
   * Get pool statistics
   * @returns {Object} Statistics
   */
  getStats() {
    return {
      total: this.portRangeEnd - this.portRangeStart + 1,
      available: this.portPool.size,
      allocated: this.allocations.size,
      utilizationPercent: ((this.allocations.size / (this.portRangeEnd - this.portRangeStart + 1)) * 100).toFixed(2),
      rangeStart: this.portRangeStart,
      rangeEnd: this.portRangeEnd
    };
  }

  /**
   * Health check a container on a port
   * @param {number} port - Port to check
   * @param {Object} options - Health check options
   * @returns {Promise<Object>} Health check result
   */
  async healthCheck(port, options = {}) {
    const {
      maxAttempts = this.healthCheckMaxAttempts,
      intervalMs = this.healthCheckIntervalMs,
      timeoutMs = this.healthCheckTimeoutMs,
      path = '/'
    } = options;

    const projectId = this.getProjectByPort(port);

    console.log(`🔍 Starting health check for port ${port} (project: ${projectId || 'unknown'})`);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        const response = await fetch(`http://localhost:${port}${path}`, {
          method: 'HEAD',
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          console.log(`✅ Health check passed for port ${port} (attempt ${attempt}/${maxAttempts})`);

          // Log success event
          if (projectId) {
            await logEvent({
              projectId,
              kind: 'health_check_passed',
              status: 'success',
              message: `Container healthy on port ${port}`,
              meta: { port, attempt, maxAttempts }
            });
          }

          return {
            healthy: true,
            port,
            attempt,
            statusCode: response.status
          };
        } else {
          console.log(`⚠️  Health check returned ${response.status} for port ${port} (attempt ${attempt}/${maxAttempts})`);
        }
      } catch (error) {
        if (error.name === 'AbortError') {
          console.log(`⏱️  Health check timeout for port ${port} (attempt ${attempt}/${maxAttempts})`);
        } else {
          console.log(`⚠️  Health check error for port ${port}: ${error.message} (attempt ${attempt}/${maxAttempts})`);
        }
      }

      // Wait before next attempt (except on last attempt)
      if (attempt < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, intervalMs));
      }
    }

    // All attempts failed
    console.log(`❌ Health check failed for port ${port} after ${maxAttempts} attempts`);

    // Log failure event
    if (projectId) {
      await logEvent({
        projectId,
        kind: 'health_check_failed',
        status: 'failure',
        message: `Container failed health check on port ${port}`,
        meta: { port, maxAttempts }
      });
    }

    return {
      healthy: false,
      port,
      attempts: maxAttempts,
      reason: 'Max attempts exceeded'
    };
  }

  /**
   * Batch health check for multiple ports
   * @param {Array<number>} ports - Ports to check
   * @param {Object} options - Health check options
   * @returns {Promise<Array>} Array of health check results
   */
  async batchHealthCheck(ports, options = {}) {
    console.log(`🔍 Starting batch health check for ${ports.length} ports`);

    const results = await Promise.all(
      ports.map(port => this.healthCheck(port, options))
    );

    const healthy = results.filter(r => r.healthy).length;
    const unhealthy = results.filter(r => !r.healthy).length;

    console.log(`✅ Batch health check complete: ${healthy} healthy, ${unhealthy} unhealthy`);

    return results;
  }

  /**
   * Find stale allocations (ports allocated but no active container)
   * This would typically be called periodically to clean up
   * @returns {Array<Object>} Stale allocations
   */
  async findStaleAllocations() {
    const stale = [];

    for (const [projectId, port] of this.allocations.entries()) {
      try {
        const result = await this.healthCheck(port, {
          maxAttempts: 2,
          intervalMs: 500,
          timeoutMs: 1000
        });

        if (!result.healthy) {
          stale.push({ projectId, port });
        }
      } catch (error) {
        console.error(`Error checking port ${port}:`, error);
        stale.push({ projectId, port, error: error.message });
      }
    }

    return stale;
  }

  /**
   * Clean up stale allocations
   * @returns {Promise<number>} Number of ports released
   */
  async cleanupStaleAllocations() {
    console.log('🧹 Starting stale allocation cleanup...');

    const stale = await this.findStaleAllocations();

    for (const { projectId, port } of stale) {
      console.log(`Releasing stale port ${port} from project ${projectId}`);
      this.releasePort(projectId);

      // Log cleanup event
      await logEvent({
        projectId,
        kind: 'port_cleanup',
        status: 'info',
        message: `Released stale port ${port}`,
        meta: { port }
      });
    }

    console.log(`✅ Cleanup complete: released ${stale.length} stale ports`);

    return stale.length;
  }

  /**
   * Reserve a specific port (for testing/debugging)
   * @param {number} port - Port to reserve
   * @param {string} projectId - Project UUID
   * @returns {boolean} True if reserved successfully
   */
  reserveSpecificPort(port, projectId) {
    if (!this.portPool.has(port)) {
      console.warn(`Port ${port} is not available`);
      return false;
    }

    this.portPool.delete(port);
    this.allocations.set(projectId, port);
    this.portToProject.set(port, projectId);

    console.log(`✅ Reserved specific port ${port} for project ${projectId}`);

    return true;
  }

  /**
   * Get all active allocations
   * @returns {Array<Object>} Active allocations
   */
  getAllocations() {
    return Array.from(this.allocations.entries()).map(([projectId, port]) => ({
      projectId,
      port
    }));
  }

  /**
   * Reset the registry (for testing)
   * WARNING: This will clear all allocations!
   */
  reset() {
    console.warn('⚠️  Resetting port registry - all allocations will be cleared!');

    this.portPool.clear();
    this.allocations.clear();
    this.portToProject.clear();
    this.initializePool();

    console.log('✅ Port registry reset complete');
  }
}

// Export singleton instance
const portRegistry = new PortRegistry();

export default portRegistry;
