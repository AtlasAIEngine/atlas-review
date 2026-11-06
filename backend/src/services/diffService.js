import { diffLines } from 'diff';

/**
 * Compute diff statistics between two file contents
 * @param {string|null} before - Original content (null for new files)
 * @param {string} after - New content
 * @returns {{ additions: number, deletions: number }}
 */
export function computeDiffStats(before, after) {
  if (before === null || before === undefined) {
    // New file - all lines are additions
    const lines = after ? (after.match(/\n/g) || []).length + (after.endsWith('\n') ? 0 : 1) : 0;
    return { additions: lines, deletions: 0 };
  }

  if (after === null || after === undefined || after === '') {
    // Deleted file - all lines are deletions
    const lines = before ? (before.match(/\n/g) || []).length + (before.endsWith('\n') ? 0 : 1) : 0;
    return { additions: 0, deletions: lines };
  }

  const diff = diffLines(before, after);
  let additions = 0;
  let deletions = 0;

  for (const part of diff) {
    const lines = part.count || 0;
    if (part.added) additions += lines;
    if (part.removed) deletions += lines;
  }

  return { additions, deletions };
}

/**
 * Detect programming language from file path
 * @param {string} filePath - File path
 * @returns {string} Monaco language identifier
 */
export function detectLanguage(filePath) {
  if (!filePath) return 'plaintext';

  const ext = filePath.split('.').pop()?.toLowerCase();

  const languageMap = {
    // JavaScript/TypeScript
    'js': 'javascript',
    'mjs': 'javascript',
    'cjs': 'javascript',
    'jsx': 'javascript',
    'ts': 'typescript',
    'tsx': 'typescript',
    'mts': 'typescript',
    'cts': 'typescript',

    // Web
    'html': 'html',
    'htm': 'html',
    'css': 'css',
    'scss': 'scss',
    'sass': 'scss',
    'less': 'less',
    'vue': 'vue',
    'svelte': 'svelte',

    // Data formats
    'json': 'json',
    'jsonc': 'json',
    'yaml': 'yaml',
    'yml': 'yaml',
    'xml': 'xml',
    'toml': 'toml',
    'ini': 'ini',
    'env': 'plaintext',

    // Documentation
    'md': 'markdown',
    'mdx': 'markdown',
    'txt': 'plaintext',
    'rst': 'restructuredtext',

    // Python
    'py': 'python',
    'pyw': 'python',
    'pyi': 'python',

    // Other languages
    'rb': 'ruby',
    'go': 'go',
    'rs': 'rust',
    'java': 'java',
    'kt': 'kotlin',
    'kts': 'kotlin',
    'scala': 'scala',
    'php': 'php',
    'c': 'c',
    'h': 'c',
    'cpp': 'cpp',
    'cc': 'cpp',
    'cxx': 'cpp',
    'hpp': 'cpp',
    'cs': 'csharp',
    'swift': 'swift',
    'r': 'r',
    'lua': 'lua',
    'pl': 'perl',
    'pm': 'perl',

    // Shell
    'sh': 'shell',
    'bash': 'shell',
    'zsh': 'shell',
    'fish': 'shell',
    'ps1': 'powershell',
    'bat': 'bat',
    'cmd': 'bat',

    // Database
    'sql': 'sql',
    'pgsql': 'pgsql',
    'mysql': 'mysql',

    // Config files
    'dockerfile': 'dockerfile',
    'makefile': 'makefile',
    'cmake': 'cmake',
    'gitignore': 'plaintext',
    'gitattributes': 'plaintext',
    'editorconfig': 'ini',

    // GraphQL
    'graphql': 'graphql',
    'gql': 'graphql',
  };

  // Check for special filenames
  const filename = filePath.split('/').pop()?.toLowerCase();
  if (filename === 'dockerfile') return 'dockerfile';
  if (filename === 'makefile') return 'makefile';
  if (filename === '.gitignore' || filename === '.gitattributes') return 'plaintext';
  if (filename === '.env' || filename?.startsWith('.env.')) return 'plaintext';

  return languageMap[ext] || 'plaintext';
}

/**
 * Check if a file is likely binary
 * @param {string} filePath - File path
 * @returns {boolean}
 */
export function isBinaryFile(filePath) {
  if (!filePath) return false;

  const ext = filePath.split('.').pop()?.toLowerCase();

  const binaryExtensions = [
    // Images
    'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'svg', 'tiff', 'tif',
    // Audio
    'mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a',
    // Video
    'mp4', 'avi', 'mov', 'wmv', 'webm', 'mkv',
    // Archives
    'zip', 'tar', 'gz', 'rar', '7z', 'bz2',
    // Documents
    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
    // Fonts
    'ttf', 'otf', 'woff', 'woff2', 'eot',
    // Executables
    'exe', 'dll', 'so', 'dylib', 'bin',
    // Other
    'lock', 'sqlite', 'db',
  ];

  return binaryExtensions.includes(ext);
}

export default {
  computeDiffStats,
  detectLanguage,
  isBinaryFile,
};
