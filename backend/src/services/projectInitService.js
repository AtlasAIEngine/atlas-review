/**
 * Project Initialization Service
 * Handles centralized project setup for newly created Atlas-owned projects.
 *
 * Called at project creation time to ensure projects are ready for:
 * - Version control (git initialized)
 * - Optional review policy save flow (.gitignore/.atlas is created on demand)
 */

import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import gitService from './gitService.js';
import { getDefaultReviewPolicyContent } from './review/reviewPolicyService.js';

const ATLAS_GITIGNORE_COMMENT = '# Atlas Engine';
const ATLAS_GITIGNORE_ENTRIES = Object.freeze([
  '.atlas/*',
  '!.atlas/review-policy.json',
]);

function buildAtlasGitignoreBlock() {
  return `${ATLAS_GITIGNORE_COMMENT}\n${ATLAS_GITIGNORE_ENTRIES.join('\n')}\n`;
}

class ProjectInitService {
  /**
   * Get standard .gitignore template
   * @returns {string} .gitignore content
   */
  getGitignoreTemplate() {
    return `# Dependencies
node_modules/
.pnp
.pnp.js

# Testing
coverage/

# Production
build/
dist/
*.tsbuildinfo

# Misc
.DS_Store
*.log
*.swp
*.swo
*~

# Environment variables
.env
.env.local
.env.development.local
.env.test.local
.env.production.local

# IDE
.vscode/
.idea/
*.sublime-*

# Temporary files
*.tmp
tmp/
temp/

${buildAtlasGitignoreBlock()}`;
  }

  /**
   * Ensure .atlas/ is listed in the project's .gitignore.
   * Creates .gitignore with the full template if missing, or appends the
   * Atlas entry to an existing file that doesn't already ignore it.
   *
   * @param {string} projectPath - Absolute path to project directory
   * @returns {Promise<'created'|'appended'|'already_present'>}
   */
  async ensureAtlasIgnored(projectPath) {
    const gitignorePath = path.join(projectPath, '.gitignore');

    if (!existsSync(gitignorePath)) {
      await fs.writeFile(gitignorePath, this.getGitignoreTemplate(), 'utf8');
      console.log(`✅ Created .gitignore at ${projectPath}`);
      return 'created';
    }

    const content = await fs.readFile(gitignorePath, 'utf8');
    const lines = content.split('\n');
    const hasModernAtlasRules = ATLAS_GITIGNORE_ENTRIES.every((entry) => lines.some((line) => line.trim() === entry));

    if (hasModernAtlasRules) {
      return 'already_present';
    }

    const filteredLines = [];
    let removedLegacyEntry = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (
        trimmed === ATLAS_GITIGNORE_COMMENT
        || trimmed === '.atlas/'
        || trimmed === '.atlas'
        || trimmed === '.atlas/*'
        || trimmed === '!.atlas/review-policy.json'
      ) {
        removedLegacyEntry = true;
        continue;
      }
      filteredLines.push(line);
    }

    while (filteredLines.length > 0 && filteredLines[filteredLines.length - 1] === '') {
      filteredLines.pop();
    }

    const nextContent = `${filteredLines.join('\n')}${filteredLines.length > 0 ? '\n\n' : ''}${buildAtlasGitignoreBlock()}`;
    await fs.writeFile(gitignorePath, nextContent, 'utf8');
    console.log(`✅ ${removedLegacyEntry ? 'Updated' : 'Appended'} Atlas .gitignore rules at ${projectPath}`);
    return removedLegacyEntry ? 'updated' : 'appended';
  }

  /**
   * Update legacy Atlas ignore rules only when they would hide the saved policy file.
   * Does not create a new .gitignore for repos that do not already ignore .atlas.
   *
   * @param {string} projectPath
   * @returns {Promise<'updated'|'already_present'|'not_needed'>}
   */
  async ensureReviewPolicyTrackable(projectPath) {
    const gitignorePath = path.join(projectPath, '.gitignore');
    if (!existsSync(gitignorePath)) {
      return 'not_needed';
    }

    const content = await fs.readFile(gitignorePath, 'utf8');
    const lines = content.split('\n');
    const hasModernAtlasRules = ATLAS_GITIGNORE_ENTRIES.every((entry) => lines.some((line) => line.trim() === entry));
    if (hasModernAtlasRules) {
      return 'already_present';
    }

    const hasLegacyAtlasIgnore = lines.some((line) => {
      const trimmed = line.trim();
      return trimmed === '.atlas/' || trimmed === '.atlas' || trimmed === '.atlas/*';
    });
    if (!hasLegacyAtlasIgnore) {
      return 'not_needed';
    }

    await this.ensureAtlasIgnored(projectPath);
    return 'updated';
  }

  async ensureDefaultReviewPolicy(projectPath) {
    const atlasDir = path.join(projectPath, '.atlas');
    const reviewPolicyPath = path.join(atlasDir, 'review-policy.json');

    await fs.mkdir(atlasDir, { recursive: true });

    if (existsSync(reviewPolicyPath)) {
      return 'already_present';
    }

    await fs.writeFile(reviewPolicyPath, getDefaultReviewPolicyContent(), 'utf8');
    console.log(`✅ Created default review policy at ${reviewPolicyPath}`);
    return 'created';
  }

  /**
   * Initialize a project repo without writing Atlas runtime metadata into it.
   *
   * @param {string} projectPath - Absolute path to project directory
   * @param {Object} options - Initialization options
   * @param {string} options.framework - Project framework (e.g., 'react', 'vue')
   * @param {string} options.language - Project language (e.g., 'typescript', 'javascript')
   * @returns {Promise<Object>} Result with status for each operation
   */
  async initializeProject(projectPath, options = {}) {
    const result = {
      git: false,
      gitignore: false,
      atlasDir: false,
      errors: []
    };

    // 1. Initialize git repository
    try {
      const isRepo = await gitService.isGitRepository(projectPath);
      if (!isRepo) {
        await gitService.initRepository(projectPath);
        console.log(`✅ Git repository initialized at ${projectPath}`);
      } else {
        console.log(`ℹ️ Git repository already exists at ${projectPath}`);
      }
      result.git = true;
    } catch (error) {
      console.warn(`⚠️ Failed to initialize git (non-critical): ${error.message}`);
      result.errors.push({ component: 'git', error: error.message });
      // Continue - git failure should not block project creation
    }

    return result;
  }

  /**
   * Check if a project has been properly initialized
   *
   * @param {string} projectPath - Absolute path to project directory
   * @returns {Promise<Object>} Status of each initialization component
   */
  async checkInitialization(projectPath) {
    const status = {
      hasGit: false,
      hasGitignore: false,
      hasAtlasDir: false,
      hasReviewPolicy: false,
    };

    try {
      status.hasGit = await gitService.isGitRepository(projectPath);
    } catch {
      status.hasGit = false;
    }

    try {
      const gitignorePath = path.join(projectPath, '.gitignore');
      status.hasGitignore = existsSync(gitignorePath);
    } catch {
      status.hasGitignore = false;
    }

    try {
      const atlasDir = path.join(projectPath, '.atlas');
      status.hasAtlasDir = existsSync(atlasDir);
    } catch {
      status.hasAtlasDir = false;
    }

    try {
      status.hasReviewPolicy = existsSync(path.join(projectPath, '.atlas', 'review-policy.json'));
    } catch {
      status.hasReviewPolicy = false;
    }

    return status;
  }
}

// Export singleton instance
const projectInitService = new ProjectInitService();
export default projectInitService;
