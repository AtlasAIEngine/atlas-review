/**
 * Provider API Routes
 * Endpoints for managing AI providers (CLI detection + BYOK).
 */

import express from 'express';
import providerService from '../services/providerService.js';

const router = express.Router();

/**
 * GET /api/providers
 * List all configured providers and active provider
 */
router.get('/', async (req, res) => {
  try {
    const result = await providerService.getProviders();
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/providers/configs
 * Get available provider types, models, and defaults
 */
router.get('/configs', (req, res) => {
  try {
    const configs = providerService.getProviderConfigs();
    res.json({ success: true, configs });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/providers/scan
 * Scan for CLI-detected providers and merge with existing BYOK
 */
router.post('/scan', async (req, res) => {
  try {
    const result = await providerService.fullScan({ force: true });
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/providers/validate
 * Re-validate all providers (test connections)
 */
router.post('/validate', async (req, res) => {
  try {
    const result = await providerService.validateAllProviders();
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/providers/test
 * Test a specific API key without saving
 */
router.post('/test', async (req, res) => {
  try {
    const { type, apiKey } = req.body;
    if (!type || !apiKey) {
      return res.status(400).json({ error: 'type and apiKey are required' });
    }

    const result = await providerService.testConnection(type, apiKey);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/providers/byok
 * Add or update a BYOK provider
 */
router.post('/byok', async (req, res) => {
  try {
    const { type, apiKey, model } = req.body;
    if (!type || !apiKey) {
      return res.status(400).json({ error: 'type and apiKey are required' });
    }

    if (!['anthropic', 'openai', 'google', 'nvidia'].includes(type)) {
      return res.status(400).json({ error: 'type must be "anthropic", "openai", "google", or "nvidia"' });
    }

    const provider = await providerService.addBYOKProvider(type, apiKey, model);
    res.json({ success: true, provider });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/providers/:providerId
 * Remove a BYOK provider
 */
router.delete('/:providerId', async (req, res) => {
  try {
    const { providerId } = req.params;
    await providerService.removeBYOKProvider(providerId);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /api/providers/active
 * Set the active provider
 */
router.put('/active', async (req, res) => {
  try {
    const { providerId } = req.body;
    if (!providerId) {
      return res.status(400).json({ error: 'providerId is required' });
    }

    const provider = await providerService.setActiveProvider(providerId);
    res.json({ success: true, provider });
  } catch (error) {
    const status = error.message.includes('not found') ? 404 : 500;
    res.status(status).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// Context-aware active provider (review vs build)
// ---------------------------------------------------------------------------

/**
 * GET /api/providers/context-active/:context
 * Get the active provider for a specific context (review or build)
 */
router.get('/context-active/:context', async (req, res) => {
  try {
    const { context } = req.params;
    if (!['review', 'build'].includes(context)) {
      return res.status(400).json({ error: 'context must be "review" or "build"' });
    }
    const result = await providerService.getContextActiveProvider(context);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /api/providers/context-active/:context
 * Set the active provider for a specific context (review or build)
 */
router.put('/context-active/:context', async (req, res) => {
  try {
    const { context } = req.params;
    if (!['review', 'build'].includes(context)) {
      return res.status(400).json({ error: 'context must be "review" or "build"' });
    }
    const { providerId, model } = req.body;
    if (!providerId) {
      return res.status(400).json({ error: 'providerId is required' });
    }
    const result = await providerService.setContextActiveProvider(context, { providerId, model });
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/providers/opencode-models-review
 * Get ALL OpenCode models (no tool-support filter) for the review system
 */
router.get('/opencode-models-review', async (req, res) => {
  try {
    const result = await providerService.getOpenCodeModelsForReview();
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// OpenCode Setup Wizard Endpoints
// ---------------------------------------------------------------------------

/**
 * GET /api/providers/opencode-status
 * Check OpenCode installation and configuration status
 */
router.get('/opencode-status', async (req, res) => {
  try {
    const status = await providerService.getOpenCodeStatus();
    res.json({ success: true, ...status });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/providers/opencode-configure
 * Deprecated: Atlas no longer mutates the user's OpenCode config.
 */
router.post('/opencode-configure', async (req, res) => {
  try {
    const status = await providerService.getOpenCodeStatus();
    res.json({
      success: true,
      changed: false,
      deprecated: true,
      message: 'Atlas no longer configures OpenCode. Use OpenCode directly with /connect and /models, then re-scan providers in Atlas.',
      configPath: null,
      configuredProviders: status.configuredProviders || [],
      activeModel: status.activeModel || null,
      configuredProvider: status.configuredProvider || null,
    });
  } catch (error) {
    res.status(200).json({
      success: true,
      changed: false,
      deprecated: true,
      message: 'Atlas no longer configures OpenCode. Use OpenCode directly with /connect and /models, then re-scan providers in Atlas.',
      error: error?.message || String(error),
    });
  }
});

/**
 * POST /api/providers/opencode-set-active
 * Deprecated: Atlas no longer mutates the user's OpenCode config.
 */
router.post('/opencode-set-active', async (req, res) => {
  try {
    const status = await providerService.getOpenCodeStatus();
    res.json({
      success: true,
      changed: false,
      deprecated: true,
      message: 'Atlas no longer sets the OpenCode model. Use OpenCode directly with /models, then re-scan providers in Atlas.',
      model: status.activeModel || null,
      configuredProviders: status.configuredProviders || [],
    });
  } catch (error) {
    res.status(200).json({
      success: true,
      changed: false,
      deprecated: true,
      message: 'Atlas no longer sets the OpenCode model. Use OpenCode directly with /models, then re-scan providers in Atlas.',
      model: null,
      error: error?.message || String(error),
    });
  }
});

/**
 * POST /api/providers/opencode-verify
 * Run a quick test prompt through OpenCode CLI
 */
router.post('/opencode-verify', async (req, res) => {
  try {
    const result = await providerService.verifyOpenCodeConnection();
    res.json({ success: result.success, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/providers/ollama-models
 * Check Ollama status and list available models
 */
router.get('/ollama-models', async (req, res) => {
  try {
    const result = await providerService.checkOllamaRunning();
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/providers/opencode-models
 * Get dynamically resolved models from OpenCode's configured providers
 */
router.get('/opencode-models', async (req, res) => {
  try {
    const result = await providerService.getOpenCodeModels();
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/providers/nvidia-models
 * Get curated list of NVIDIA NIM models
 */
router.get('/nvidia-models', (req, res) => {
  try {
    const toolSupportOnly = req.query.toolSupportOnly === 'true';
    const reviewCapableOnly = req.query.reviewCapableOnly === 'true';
    const models = providerService.listNvidiaNimModels({ toolSupportOnly, reviewCapableOnly });
    res.json({ success: true, models });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /api/providers/:providerId/model
 * Update the model for a provider
 */
router.put('/:providerId/model', async (req, res) => {
  try {
    const { providerId } = req.params;
    const { model } = req.body;
    if (!model) {
      return res.status(400).json({ error: 'model is required' });
    }

    const { providers } = await providerService.getProviders();
    const existingProvider = Array.isArray(providers)
      ? providers.find((candidate) => candidate?.id === providerId)
      : null;
    if (!existingProvider) {
      return res.status(404).json({ error: 'Provider not found' });
    }
    if (existingProvider.type === 'opencode') {
      return res.json({
        success: true,
        provider: existingProvider,
        changed: false,
        deprecated: true,
        message: 'Atlas no longer sets the OpenCode model. Use OpenCode directly with /models, then re-scan providers in Atlas.',
      });
    }

    const provider = await providerService.updateProviderModel(providerId, model);

    res.json({ success: true, provider });
  } catch (error) {
    const status = error.message.includes('not found') ? 404 : 500;
    res.status(status).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// CLI Auth Status
// ---------------------------------------------------------------------------

/**
 * GET /api/providers/cli-auth-status
 * Check authentication status for CLI tools (Claude Code, Codex, Gemini CLI)
 */
router.get('/cli-auth-status', async (req, res) => {
  try {
    const auth = await providerService.getCliAuthStatus();

    res.json({ success: true, auth });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// CLI install/status endpoints
// ---------------------------------------------------------------------------

/**
 * GET /api/providers/cli-install-status
 * Compatibility status for setup UI. Atlas no longer installs CLIs; installed
 * state is derived from user-installed CLI discovery only.
 */
router.get('/cli-install-status', async (req, res) => {
  try {
    const auth = await providerService.getCliAuthStatus();
    const installed = Object.fromEntries(
      Object.entries(auth || {}).map(([key, tool]) => [
        key,
        {
          installed: Boolean(tool?.binaryPath),
          binaryPath: tool?.binaryPath || null,
        },
      ])
    );

    res.json({
      success: true,
      disabled: true,
      npmAvailable: false,
      npmSource: null,
      installableTools: [],
      installed,
      activeAttempts: {},
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/providers/install-cli
 * Disabled legacy Atlas-managed CLI installer.
 */
router.post('/install-cli', async (req, res) => {
  res.status(410).json({
    success: false,
    disabled: true,
    error: 'Atlas-managed CLI installation is disabled. Install the CLI in your terminal, then rescan.',
  });
});

/**
 * GET /api/providers/install-cli/:attemptId
 * Disabled legacy Atlas-managed CLI installer status.
 */
router.get('/install-cli/:attemptId', async (req, res) => {
  res.status(410).json({
    success: false,
    disabled: true,
    error: 'Atlas-managed CLI installation is disabled. Install the CLI in your terminal, then rescan.',
  });
});

export default router;
