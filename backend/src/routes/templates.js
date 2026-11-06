/**
 * Template Routes
 * Serves the template manifest for the homepage template picker.
 */

import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const router = express.Router();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = path.resolve(__dirname, '../../../templates/manifest.json');

// Cache the manifest in memory after first read
let _manifestCache = null;

async function loadManifest() {
  if (_manifestCache) return _manifestCache;
  try {
    const raw = await fs.readFile(MANIFEST_PATH, 'utf-8');
    _manifestCache = JSON.parse(raw);
    return _manifestCache;
  } catch (err) {
    console.warn('[templates] Could not load manifest:', err.message);
    return { version: 1, templates: [] };
  }
}

/**
 * GET /api/templates
 * Returns the list of available project templates.
 */
router.get('/', async (_req, res) => {
  try {
    const manifest = await loadManifest();
    res.json({ success: true, templates: manifest.templates });
  } catch (err) {
    console.error('[templates] Error serving templates:', err);
    res.json({ success: true, templates: [] });
  }
});

/**
 * Look up a template by ID. Used internally by the projects route.
 */
export async function getTemplateById(templateId) {
  const manifest = await loadManifest();
  return manifest.templates.find(t => t.id === templateId) || null;
}

export default router;
