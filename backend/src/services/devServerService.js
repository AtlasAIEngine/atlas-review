/**
 * Development Server Service
 * Manages development servers for projects (Vite, Next.js, etc.)
 */

import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import net from 'net';
import portRegistry from './portRegistry.js';
import databaseService from './databaseService.js';
import supabaseService from './supabaseService.js';
import cliInstallService from './cliInstallService.js';
import { detectFrameworkType, SUPABASE_ENV_VAR_MAP } from './integrationsService.js';

export function buildSpawnEnv(
  baseEnv = process.env,
  {
    platform = process.platform,
    nodeExecPath = process.execPath,
  } = {},
) {
  const spawnEnv = { ...baseEnv };
  if (platform !== 'win32') {
    return spawnEnv;
  }

  const nodeDir = path.win32.dirname(nodeExecPath);
  const pathKey = Object.keys(spawnEnv).find((key) => key.toUpperCase() === 'PATH') || 'PATH';
  const currentPath = spawnEnv[pathKey] || '';
  const pathDelimiter = platform === 'win32' ? ';' : path.delimiter;

  if (!currentPath.includes(nodeDir)) {
    spawnEnv[pathKey] = currentPath
      ? `${nodeDir}${pathDelimiter}${currentPath}`
      : nodeDir;
  }

  return spawnEnv;
}

export function shouldUseShellForPackageManager(npmSource, platform = process.platform) {
  return npmSource === 'system' && platform === 'win32';
}

async function resolvePackageManagerSpawn(command, args) {
  if (command !== 'npm') {
    return { command, args, shell: false };
  }

  const npm = await cliInstallService.ensureNpm();
  return {
    command: npm.cmd,
    args: [...npm.args, ...args],
    shell: shouldUseShellForPackageManager(npm.source),
  };
}

class DevServerService {
  constructor() {
    // Map of projectId -> { process, port, status, logs }
    this.servers = new Map();
    // Track in-flight start operations to prevent concurrent npm installs
    // that corrupt node_modules and cause repeated 500 errors.
    this._startingPromises = new Map();
  }

  /**
   * Check if a port is actually available for binding
   * @param {number} port - Port to check
   * @returns {Promise<boolean>} True if port is available
   */
  async isPortAvailable(port) {
    return new Promise((resolve) => {
      const server = net.createServer();

      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          resolve(false); // Port is in use
        } else {
          resolve(false); // Other error, assume not available
        }
      });

      server.once('listening', () => {
        server.close();
        resolve(true); // Port is available
      });

      server.listen(port, '0.0.0.0');
    });
  }

  /**
   * Detect project type by reading package.json
   */
  async detectProjectType(projectPath, port) {
    try {
      const packageJsonPath = path.join(projectPath, 'package.json');
      const content = await fs.readFile(packageJsonPath, 'utf-8');
      const packageJson = JSON.parse(content);

      // Check dependencies and scripts
      const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
      const scripts = packageJson.scripts || {};

      if (deps.vite || scripts.dev?.includes('vite')) {
        return {
          type: 'vite',
          command: 'npm',
          args: ['run', 'dev', '--', '--port', port.toString(), '--host'],
          env: { PORT: port.toString() } // Also set env var for custom servers
        };
      }

      if (deps.next || scripts.dev?.includes('next')) {
        return {
          type: 'next',
          command: 'npm',
          args: ['run', 'dev', '--', '--port', port.toString()],
          env: { PORT: port.toString() } // Also set env var for custom servers
        };
      }

      if (deps['react-scripts']) {
        return { type: 'cra', command: 'npm', args: ['start'], env: { PORT: port.toString() } };
      }

      return null; // Not a recognized dev server project
    } catch (error) {
      console.error('Failed to detect project type:', error.message);
      return null;
    }
  }

  /**
   * Check if node_modules exists
   */
  async hasNodeModules(projectPath) {
    try {
      const nodeModulesPath = path.join(projectPath, 'node_modules');
      await fs.access(nodeModulesPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if project needs a database and provision if needed
   * @param {string} projectId - Project UUID
   * @param {string} projectPath - Path to project directory
   */
  async checkAndProvisionDatabase(projectId, projectPath) {
    try {
      // Check if database already provisioned
      const dbInfo = await databaseService.getDatabaseInfo(projectId);
      if (dbInfo && dbInfo.provisioned) {
        console.log(`✅ Database already provisioned for project ${projectId}`);
        return;
      }

      // Read package.json to detect database need
      const packageJsonPath = path.join(projectPath, 'package.json');
      let packageJsonContent;

      try {
        packageJsonContent = await fs.readFile(packageJsonPath, 'utf-8');
      } catch (error) {
        // No package.json, skip database provisioning
        console.log(`📄 No package.json found, skipping database provisioning`);
        return;
      }

      // Detect if database is needed
      const detection = databaseService.detectDatabaseNeed(packageJsonContent);

      if (!detection.needsDatabase) {
        console.log(`📊 No database dependencies detected, skipping provisioning`);
        return;
      }

      console.log(`🗄️  Database dependency detected: ${detection.package} (${detection.type})`);
      console.log(`📊 Provisioning PostgreSQL database...`);

      // Get project name from package.json
      const packageJson = JSON.parse(packageJsonContent);
      const projectName = packageJson.name || `project_${projectId.substring(0, 8)}`;

      // Provision database
      const credentials = await databaseService.provisionDatabase(projectId, projectName);

      // Update project record
      await databaseService.updateProjectDatabase(projectId, credentials);

      // Update .env file with DATABASE_URL
      const envPath = path.join(projectPath, '.env');
      let envContent = '';

      try {
        envContent = await fs.readFile(envPath, 'utf-8');
      } catch {
        // .env doesn't exist, will create it
      }

      const lines = envContent.split('\n');
      let databaseUrlUpdated = false;

      const updatedLines = lines.map(line => {
        if (line.trim().match(/^DATABASE_URL\s*=/i)) {
          databaseUrlUpdated = true;
          return `DATABASE_URL=${credentials.databaseUrl}`;
        }
        return line;
      });

      if (!databaseUrlUpdated) {
        updatedLines.push(`DATABASE_URL=${credentials.databaseUrl}`);
      }

      await fs.writeFile(envPath, updatedLines.join('\n'), 'utf-8');
      console.log(`✅ DATABASE_URL added to .env file`);
      console.log(`🎉 Database provisioning complete!`);

    } catch (error) {
      // Don't fail the dev server startup if database provisioning fails
      console.error(`⚠️  Database provisioning failed (non-critical):`, error.message);
      console.log(`💡 You can manually add DATABASE_URL to your .env file if needed`);
    }
  }

  /**
   * Inject Supabase environment variables into the project .env if linked.
   * Falls back to auto-linking if the project uses @supabase/supabase-js but isn't linked yet.
   * @param {string} projectId
   * @param {string} projectPath
   * @param {string} [userId] - Needed for auto-link fallback
   */
  async checkAndInjectSupabaseEnv(projectId, projectPath, userId) {
    try {
      let linked = await supabaseService.getLinkedProjectWithSecrets(projectId);

      // Detect if project uses Supabase (needed for auto-link and placeholder fallback)
      let usesSupabase = false;
      let framework = 'node';
      try {
        const pkgPath = path.join(projectPath, 'package.json');
        const pkgContent = await fs.readFile(pkgPath, 'utf-8');
        const pkg = JSON.parse(pkgContent);
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        usesSupabase = !!deps['@supabase/supabase-js'];
        framework = detectFrameworkType(pkg);
      } catch {
        // No package.json
      }

      // Fallback: if not linked but project uses Supabase, try auto-link
      if (!linked && usesSupabase && userId) {
        try {
          console.log('🔗 Supabase dependency detected but not linked — attempting auto-link...');
          const autoResult = await supabaseService.autoLinkIfSingleProject(projectId, userId, projectPath);
          if (autoResult?.autoLinked) {
            linked = await supabaseService.getLinkedProjectWithSecrets(projectId);
          }
        } catch {
          // Auto-link failed — will fall through to placeholder injection
        }
      }

      // Last resort: inject placeholder values so createClient() doesn't throw
      // and crash the entire React app with a blank screen
      if (!linked && usesSupabase) {
        console.warn('⚠️  Supabase dependency detected but no project linked and auto-link unavailable.');
        console.warn('   Injecting placeholder env vars to prevent app crash.');
        console.warn('   → Configure real Supabase keys in Settings > Supabase for live database access.');

        const envMap = SUPABASE_ENV_VAR_MAP[framework] || SUPABASE_ENV_VAR_MAP.node;
        const placeholderUrl = 'https://localhost.invalid';
        const placeholderKey = 'placeholder_connect_supabase_in_settings';

        const envPath = path.join(projectPath, '.env');
        let envContent = '';
        try {
          envContent = await fs.readFile(envPath, 'utf-8');
        } catch {
          // .env doesn't exist, will create it
        }

        // Only inject if not already present
        const existingKeys = new Set(
          envContent.split('\n')
            .map(l => l.match(/^(\w+)\s*=/))
            .filter(Boolean)
            .map(m => m[1])
        );

        const placeholders = {};
        if (!existingKeys.has(envMap.url)) placeholders[envMap.url] = placeholderUrl;
        if (!existingKeys.has(envMap.anonKey)) placeholders[envMap.anonKey] = placeholderKey;
        if (!existingKeys.has('SUPABASE_URL')) placeholders.SUPABASE_URL = placeholderUrl;
        if (!existingKeys.has('SUPABASE_ANON_KEY')) placeholders.SUPABASE_ANON_KEY = placeholderKey;

        if (Object.keys(placeholders).length > 0) {
          const lines = envContent ? envContent.split('\n') : [];
          for (const [key, value] of Object.entries(placeholders)) {
            lines.push(`${key}=${value}`);
          }
          await fs.writeFile(envPath, lines.join('\n'), 'utf-8');
          console.log('📝 Placeholder Supabase env vars written to .env');
        }

        return { placeholderInjected: true, missingKeys: Object.keys(placeholders) };
      }

      if (!linked) return null;

      const envPath = path.join(projectPath, '.env');
      let envContent = '';
      try {
        envContent = await fs.readFile(envPath, 'utf-8');
      } catch {
        // .env doesn't exist, will create it
      }

      // framework was already detected above
      const envMap = SUPABASE_ENV_VAR_MAP[framework] || SUPABASE_ENV_VAR_MAP.node;

      // Inject both unprefixed (server-side) and framework-prefixed (client-side) vars
      const vars = {
        SUPABASE_URL: linked.supabase_url,
        SUPABASE_ANON_KEY: linked.anon_key,
      };
      // Add framework-prefixed variants (deduplicates for 'node')
      if (envMap.url !== 'SUPABASE_URL') {
        vars[envMap.url] = linked.supabase_url;
      }
      if (envMap.anonKey !== 'SUPABASE_ANON_KEY') {
        vars[envMap.anonKey] = linked.anon_key;
      }
      if (linked.serviceRoleKey) {
        vars.SUPABASE_SERVICE_ROLE_KEY = linked.serviceRoleKey;
      }
      if (linked.databaseUrl) {
        vars.DATABASE_URL = linked.databaseUrl;
      }

      const lines = envContent.split('\n');
      const existingKeys = new Set();
      const updatedLines = lines.map(line => {
        const match = line.match(/^(\w+)\s*=/);
        if (match && vars[match[1]] !== undefined) {
          existingKeys.add(match[1]);
          return `${match[1]}=${vars[match[1]]}`;
        }
        return line;
      });

      for (const [key, value] of Object.entries(vars)) {
        if (!existingKeys.has(key) && value) {
          updatedLines.push(`${key}=${value}`);
        }
      }

      await fs.writeFile(envPath, updatedLines.join('\n'), 'utf-8');
      console.log(`✅ Supabase env vars injected for project ${projectId}`);
    } catch (error) {
      console.error(`⚠️  Supabase env injection failed (non-critical):`, error.message);
    }
  }

  /**
   * Update .env file with allocated port
   * @param {string} projectPath - Path to project directory
   * @param {number} port - Allocated port number
   */
  async updateEnvFile(projectPath, port) {
    try {
      const envPath = path.join(projectPath, '.env');

      // Check if .env file exists
      try {
        await fs.access(envPath);
      } catch {
        // No .env file, nothing to update
        console.log(`📄 No .env file found in ${projectPath}, skipping update`);
        return;
      }

      // Read existing .env file
      const envContent = await fs.readFile(envPath, 'utf-8');

      // Parse .env file and update PORT variable
      const lines = envContent.split('\n');
      let portUpdated = false;

      const updatedLines = lines.map(line => {
        // Match PORT=xxx (with optional whitespace)
        if (line.trim().match(/^PORT\s*=/i)) {
          portUpdated = true;
          return `PORT=${port}`;
        }
        return line;
      });

      // If PORT wasn't found, add it
      if (!portUpdated) {
        updatedLines.push(`PORT=${port}`);
      }

      // Write updated .env file
      await fs.writeFile(envPath, updatedLines.join('\n'), 'utf-8');
      console.log(`✅ Updated .env file with PORT=${port}`);
    } catch (error) {
      console.error(`Failed to update .env file:`, error.message);
      // Don't throw - this is not critical, environment variable will still be set
    }
  }

  /**
   * Install dependencies
   */
  async installDependencies(projectId, projectPath) {
    const npmSpawn = await resolvePackageManagerSpawn('npm', ['install', '--include=dev']);
    return new Promise((resolve, reject) => {
      console.log(`📦 Installing dependencies for project ${projectId}...`);

      // Use --include=dev because the backend may run with NODE_ENV=production
      // (Tauri sets this), which causes npm to skip devDependencies by default.
      // Dev servers (vite, next, etc.) are always devDependencies.
      const installProcess = spawn(npmSpawn.command, npmSpawn.args, {
        cwd: projectPath,
        env: buildSpawnEnv(),
        shell: npmSpawn.shell,
        stdio: 'pipe',
        windowsHide: true,
      });

      let settled = false;
      let stdout = '';
      let stderr = '';

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };

      installProcess.stdout.on('data', (data) => {
        stdout += data.toString();
        console.log(`[${projectId}] ${data.toString().trim()}`);
      });

      installProcess.stderr.on('data', (data) => {
        stderr += data.toString();
        console.error(`[${projectId}] ${data.toString().trim()}`);
      });

      installProcess.on('error', (error) => {
        console.error(`Failed to launch npm install for project ${projectId}:`, error);
        finish(reject, new Error(`Failed to launch npm install: ${error.message}`));
      });

      installProcess.on('close', (code) => {
        if (code === 0) {
          console.log(`✅ Dependencies installed for project ${projectId}`);
          finish(resolve, { success: true, stdout, stderr });
        } else {
          console.error(`❌ Failed to install dependencies for project ${projectId}`);
          finish(reject, new Error(`npm install failed with code ${code}\n${stderr}`));
        }
      });
    });
  }

  /**
   * Start development server.
   * Serialises concurrent calls for the same project so only one npm-install /
   * spawn cycle runs at a time.  Without this, two concurrent React effects
   * can both enter startDevServer before `this.servers` has an entry, leading
   * to competing `npm install` processes that corrupt node_modules and return
   * repeated 500 errors on the first 1-2 attempts after app launch.
   */
  async startDevServer(projectId, projectPath, userId) {
    // Fast path: already running
    if (this.servers.has(projectId)) {
      const existing = this.servers.get(projectId);
      if (existing.status === 'running') {
        console.log(`Dev server already running for project ${projectId}`);
        return {
          success: true,
          running: true,
          port: existing.port,
          url: `http://localhost:${existing.port}`,
          status: 'running',
          projectType: existing.projectType,
        };
      }
    }

    // If a start is already in flight for this project, piggyback on it
    const inflight = this._startingPromises.get(projectId);
    if (inflight) {
      console.log(`Dev server start already in progress for ${projectId}, waiting for it…`);
      return inflight;
    }

    // Run the actual start with one silent retry for transient errors
    const promise = this._startWithRetry(projectId, projectPath, userId)
      .finally(() => {
        this._startingPromises.delete(projectId);
      });
    this._startingPromises.set(projectId, promise);
    return promise;
  }

  /**
   * Attempt _doStartDevServer with automatic retries for transient errors
   * (port conflicts, npm install races, process startup timing, etc.).
   */
  async _startWithRetry(projectId, projectPath, userId, attempt = 1) {
    const MAX_ATTEMPTS = 3;
    const RETRY_DELAYS = [1500, 3000]; // progressive backoff
    try {
      return await this._doStartDevServer(projectId, projectPath, userId);
    } catch (error) {
      // Don't retry non-transient errors
      const msg = error.message || '';
      const nonRetryable = msg.includes('Not a recognized dev server project')
        || msg.includes('No available ports');
      if (nonRetryable || attempt >= MAX_ATTEMPTS) {
        throw error;
      }

      const delay = RETRY_DELAYS[attempt - 1] || 3000;
      console.log(`⟳ Dev server start attempt ${attempt}/${MAX_ATTEMPTS} failed (${msg}), retrying in ${delay}ms…`);
      await new Promise(r => setTimeout(r, delay));
      return this._startWithRetry(projectId, projectPath, userId, attempt + 1);
    }
  }

  /**
   * Internal: performs the actual dev-server start work.
   * Only called from startDevServer() which ensures single-flight per project.
   */
  async _doStartDevServer(projectId, projectPath, userId) {
    try {
      // Re-check in case server came up while we were queued
      if (this.servers.has(projectId)) {
        const existing = this.servers.get(projectId);
        if (existing.status === 'running') {
          return {
            success: true,
            running: true,
            port: existing.port,
            url: `http://localhost:${existing.port}`,
            status: 'running',
            projectType: existing.projectType,
          };
        }
      }

      // Allocate port first (needed for some frameworks like Vite)
      const port = await portRegistry.allocatePort(projectId, userId);
      console.log(`📡 Allocated port ${port} for dev server`);

      // Verify port is actually available before proceeding
      const portAvailable = await this.isPortAvailable(port);
      if (!portAvailable) {
        console.error(`❌ Port ${port} is not available despite allocation! Releasing port.`);
        await portRegistry.releasePort(port);
        throw new Error(`Port ${port} is already in use by another process`);
      }

      // Detect project type with port
      const projectType = await this.detectProjectType(projectPath, port);
      if (!projectType) {
        await portRegistry.releasePort(port);
        throw new Error('Not a recognized dev server project (no Vite, Next.js, or CRA detected)');
      }

      console.log(`🔍 Detected ${projectType.type} project`);

      // Always run npm install to ensure dependencies are up-to-date.
      // A node_modules directory may exist from a previous partial/failed install,
      // and checking directory existence alone is not reliable.
      // When packages are already installed, npm install finishes in ~1-2 seconds.
      await this.installDependencies(projectId, projectPath);

      // Check if project needs a database and provision if needed
      await this.checkAndProvisionDatabase(projectId, projectPath);

      // Inject Supabase env vars if a Supabase project is linked (or auto-link)
      const supabaseResult = await this.checkAndInjectSupabaseEnv(projectId, projectPath, userId);

      // Update .env file with allocated port (if it exists)
      await this.updateEnvFile(projectPath, port);

      // Set environment variables for the dev server
      const env = {
        ...process.env,
        // Disable browser auto-open
        BROWSER: 'none',
        // Merge any framework-specific env vars (e.g., CRA uses PORT)
        ...(projectType.env || {}),
      };

      // Start dev server process
      console.log(`🚀 Starting ${projectType.type} dev server on port ${port}...`);
      const serverSpawn = await resolvePackageManagerSpawn(projectType.command, projectType.args);
      const serverProcess = spawn(serverSpawn.command, serverSpawn.args, {
        cwd: projectPath,
        env: buildSpawnEnv(env),
        shell: serverSpawn.shell,
        stdio: 'pipe',
        windowsHide: true,
      });

      const serverInfo = {
        process: serverProcess,
        port,
        status: 'starting',
        logs: [],
        projectType: projectType.type,
        startedAt: new Date(),
        supabasePlaceholder: supabaseResult?.placeholderInjected
          ? { injected: true, missingKeys: supabaseResult.missingKeys }
          : undefined,
      };

      this.servers.set(projectId, serverInfo);

      // Capture logs
      serverProcess.stdout.on('data', (data) => {
        const log = data.toString();
        serverInfo.logs.push({ type: 'stdout', message: log, timestamp: new Date() });
        console.log(`[${projectId}:${port}] ${log.trim()}`);

        // Detect actual port from Vite output (in case it auto-incremented)
        // Vite outputs: "➜  Local:   http://localhost:3005/"
        const vitePortMatch = log.match(/Local:\s+http:\/\/localhost:(\d+)/);
        if (vitePortMatch) {
          const actualPort = parseInt(vitePortMatch[1], 10);
          if (actualPort !== serverInfo.port) {
            console.log(`⚠️  Vite auto-incremented port: ${serverInfo.port} → ${actualPort}`);
            // Update the allocation so cleanup/status calls stay consistent.
            portRegistry.reassignPort(projectId, actualPort);
            serverInfo.port = actualPort;
          }
        }

        // Detect when server is ready
        if (
          log.includes('ready in') || // Vite
          log.includes('Local:') || // Vite
          log.includes('compiled successfully') || // Next.js/CRA
          log.includes('started server on') || // Next.js
          log.includes('serving on port') // Express/custom servers
        ) {
          serverInfo.status = 'running';
          console.log(`✅ Dev server running for ${projectId} on http://localhost:${serverInfo.port}`);
        }
      });

      serverProcess.stderr.on('data', (data) => {
        const log = data.toString();
        serverInfo.logs.push({ type: 'stderr', message: log, timestamp: new Date() });
        console.error(`[${projectId}:${port}] ${log.trim()}`);

        // Detect if project tried to bind to wrong port (especially system ports like 3000)
        if (log.includes('EADDRINUSE') || log.includes('address already in use')) {
          // Extract port number from error message if possible
          const portMatch = log.match(/(?:port|:)(\d{4,5})/i);
          const conflictPort = portMatch ? parseInt(portMatch[1], 10) : null;

          if (conflictPort && conflictPort !== serverInfo.port) {
            console.error(`🚨 CRITICAL: Project ${projectId} tried to bind to port ${conflictPort} instead of assigned port ${serverInfo.port}`);
            console.error(`🚨 Killing rogue dev server to protect system integrity`);

            // Kill only this project's process, not the backend
            serverInfo.process.kill('SIGKILL');
            serverInfo.status = 'error';
            serverInfo.error = `Project attempted to bind to unauthorized port ${conflictPort}`;
          }
        }
      });

      serverProcess.on('close', (code) => {
        console.log(`Dev server stopped for ${projectId} (exit code: ${code})`);
        serverInfo.status = 'stopped';
        this.servers.delete(projectId);
        portRegistry.releasePort(projectId);
      });

      serverProcess.on('error', (error) => {
        console.error(`Dev server error for ${projectId}:`, error);
        serverInfo.status = 'error';
        serverInfo.error = error.message;
      });

      // Wait for server to be ready (max 45 seconds — cold npm installs can be slow)
      const maxWait = 45000;
      const startTime = Date.now();
      while (serverInfo.status === 'starting' && Date.now() - startTime < maxWait) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      if (serverInfo.status !== 'running') {
        throw new Error('Dev server failed to start within 45 seconds');
      }

      return {
        success: true,
        running: true, // Boolean flag for frontend
        port: serverInfo.port, // Use actual port (may have auto-incremented)
        url: `http://localhost:${serverInfo.port}`,
        status: 'running',
        projectType: projectType.type,
        ...(supabaseResult?.placeholderInjected && {
          supabasePlaceholder: {
            injected: true,
            missingKeys: supabaseResult.missingKeys,
          },
        }),
      };
    } catch (error) {
      console.error(`Failed to start dev server for ${projectId}:`, error);

      // Ensure port is released on error
      try {
        const allocatedPort = portRegistry.getPort(projectId);
        if (allocatedPort) {
          await portRegistry.releasePort(projectId);
        }
      } catch (releaseError) {
        console.error(`Error releasing port after dev server failure:`, releaseError);
      }

      // Clean up server entry
      this.servers.delete(projectId);

      // Throw error to caller but don't crash backend
      throw new Error(`Dev server failed: ${error.message}`);
    }
  }

  /**
   * Stop development server
   */
  async stopDevServer(projectId) {
    const serverInfo = this.servers.get(projectId);
    if (!serverInfo) {
      return { success: false, message: 'No dev server running for this project' };
    }

    try {
      console.log(`🛑 Stopping dev server for ${projectId}...`);

      // Kill the process
      serverInfo.process.kill('SIGTERM');

      // Wait a bit for graceful shutdown
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Force kill if still running
      if (!serverInfo.process.killed) {
        serverInfo.process.kill('SIGKILL');
      }

      // Release port
      await portRegistry.releasePort(projectId);

      // Remove from map
      this.servers.delete(projectId);

      console.log(`✅ Dev server stopped for ${projectId}`);
      return { success: true, message: 'Dev server stopped' };
    } catch (error) {
      console.error(`Failed to stop dev server for ${projectId}:`, error);
      throw error;
    }
  }

  /**
   * Detect whether a project requires a dev server
   */
  async detectDevServerProject(projectPath) {
    const detection = await this.detectProjectType(projectPath, 3000);
    if (!detection) {
      return { running: false, requiresDevServer: false };
    }

    return {
      running: false,
      requiresDevServer: true,
      projectType: detection.type,
    };
  }

  /**
   * Get dev server status
   */
  async getDevServerStatus(projectId, projectPath = null) {
    const serverInfo = this.servers.get(projectId);
    if (!serverInfo) {
      if (projectPath) {
        return await this.detectDevServerProject(projectPath);
      }
      return { running: false };
    }

    return {
      running: serverInfo.status === 'running',
      port: serverInfo.port,
      url: `http://localhost:${serverInfo.port}`,
      status: serverInfo.status,
      error: serverInfo.error || null,
      projectType: serverInfo.projectType,
      startedAt: serverInfo.startedAt,
      uptime: Date.now() - serverInfo.startedAt.getTime(),
      requiresDevServer: true,
      ...(serverInfo.supabasePlaceholder && {
        supabasePlaceholder: serverInfo.supabasePlaceholder,
      }),
    };
  }

  /**
   * Get dev server logs
   */
  getDevServerLogs(projectId, limit = 100) {
    const serverInfo = this.servers.get(projectId);
    if (!serverInfo) {
      return [];
    }

    return serverInfo.logs.slice(-limit);
  }

  /**
   * Stop all dev servers (cleanup on shutdown)
   */
  async stopAllDevServers() {
    console.log('🧹 Stopping all dev servers...');
    const promises = [];
    for (const [projectId] of this.servers) {
      promises.push(this.stopDevServer(projectId));
    }
    await Promise.allSettled(promises);
    console.log('✅ All dev servers stopped');
  }
}

// Singleton instance
const devServerService = new DevServerService();

// Cleanup on process exit
process.on('SIGINT', async () => {
  await devServerService.stopAllDevServers();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await devServerService.stopAllDevServers();
  process.exit(0);
});

export default devServerService;
