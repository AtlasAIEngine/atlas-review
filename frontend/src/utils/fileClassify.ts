/**
 * Path-based file classification shared across the Direction C UI. Ports
 * the regex buckets from `backend/src/services/review/reviewIgnorePatterns.js`
 * so the frontend groups files by the same tech-stack / type semantics the
 * review pipeline uses. Code groups are split further by language so
 * mixed-stack repos don't bury one language under another.
 */

const CODE_FILE_RE = /\.(c|cc|cpp|cs|go|java|js|jsx|kt|mjs|py|rb|rs|swift|ts|tsx|h|hpp|hlsl|m|mm|scala|sh|lua|dart|vue|svelte)$/i;
const CONFIG_FILE_RE = /(^|\/)(config|configs|settings|docker|deploy|infra)\b|(^|\/)\.?env(\.|$)|(^|\/)(package|tsconfig|vite|webpack|babel|jest|vitest|eslint|prettier|caddy|nginx|docker-compose)\b/i;
const TEST_FILE_RE = /(^|\/)(__tests__|tests?|specs?)(\/|$)|\.(test|spec)\.[^/]+$/i;
const DOC_FILE_RE = /(^|\/)(readme|changelog|contributing|license)(\.[^/]+)?$|\.mdx?$/i;

export type FileCategory = 'code' | 'test' | 'config' | 'doc' | 'other';

export interface FileClassification {
  category: FileCategory;
  /** Language display label for `code` files (e.g. "TypeScript", "Python"). Null for non-code. */
  language: string | null;
  /** Stable ordering key for top-level groups. Lower = shown first. */
  order: number;
  /** Human-readable group label: "TypeScript" / "Tests" / "Config" / "Docs" / "Other". */
  groupLabel: string;
}

const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: 'TypeScript',
  tsx: 'TypeScript',
  js: 'JavaScript',
  jsx: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  py: 'Python',
  go: 'Go',
  rs: 'Rust',
  java: 'Java',
  kt: 'Kotlin',
  swift: 'Swift',
  c: 'C',
  cc: 'C++',
  cpp: 'C++',
  h: 'C/C++ headers',
  hpp: 'C/C++ headers',
  cs: 'C#',
  rb: 'Ruby',
  m: 'Objective-C',
  mm: 'Objective-C',
  scala: 'Scala',
  sh: 'Shell',
  lua: 'Lua',
  dart: 'Dart',
  vue: 'Vue',
  svelte: 'Svelte',
  hlsl: 'HLSL',
};

// Languages the user is most likely to care about first when scanning
// multi-language repos. Languages not in this list fall through to an
// alphabetical tail inside the Code block.
const LANGUAGE_PRIORITY: string[] = [
  'TypeScript', 'JavaScript', 'Python', 'Go', 'Rust', 'Java', 'Kotlin',
  'Swift', 'C#', 'C++', 'C', 'Ruby',
];

/**
 * Classify a file path. Precedence is: test → doc → config → code → other.
 * A `foo.test.ts` is a Test, not TypeScript code.
 */
export function classifyFile(path: string): FileClassification {
  const normalized = (path || '').trim();

  if (TEST_FILE_RE.test(normalized)) {
    return { category: 'test', language: null, order: 100, groupLabel: 'Tests' };
  }
  if (DOC_FILE_RE.test(normalized)) {
    return { category: 'doc', language: null, order: 120, groupLabel: 'Docs' };
  }
  if (CONFIG_FILE_RE.test(normalized)) {
    return { category: 'config', language: null, order: 110, groupLabel: 'Config' };
  }
  if (CODE_FILE_RE.test(normalized)) {
    const ext = (normalized.split('.').pop() || '').toLowerCase();
    const language = LANGUAGE_BY_EXT[ext] || ext.toUpperCase();
    const priority = LANGUAGE_PRIORITY.indexOf(language);
    // Priority-listed languages rank 0..N; others get 50..inf by language name hash.
    const order = priority >= 0 ? priority : 50 + simpleStringOrder(language);
    return { category: 'code', language, order, groupLabel: language };
  }
  return { category: 'other', language: null, order: 200, groupLabel: 'Other' };
}

function simpleStringOrder(s: string): number {
  // Returns a small positive offset so unknown-language groups sort
  // alphabetically but still come before Tests/Config/Docs/Other.
  let n = 0;
  for (let i = 0; i < Math.min(4, s.length); i++) {
    n = n * 31 + s.charCodeAt(i);
  }
  return (n & 0x7fff) / 0x7fff * 40; // 0..40
}
