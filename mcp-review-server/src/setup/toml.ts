export interface TomlSectionRange {
  name: string;
  startLine: number;
  endLine: number;
}

const SECTION_HEADER_REGEX = /^\s*\[([^[\]]+)\]\s*$/;
const ARRAY_HEADER_REGEX = /^\s*\[\[([^[\]]+)\]\]\s*$/;

function unquoteTomlKeyPart(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if (first === '"' && last === '"') {
      return trimmed.slice(1, -1).replace(/\\(["\\])/g, '$1');
    }
    if (first === '\'' && last === '\'') {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function splitTomlDottedKey(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | '\'' | null = null;
  let escaped = false;

  for (const char of value) {
    if (quote) {
      if (escaped) {
        current += char;
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        current += char;
        continue;
      }
      if (char === quote) {
        quote = null;
        current += char;
        continue;
      }
      current += char;
      continue;
    }

    if (char === '"' || char === '\'') {
      quote = char;
      current += char;
      continue;
    }

    if (char === '.') {
      if (current.trim()) {
        parts.push(unquoteTomlKeyPart(current));
      }
      current = '';
      continue;
    }

    current += char;
  }

  if (current.trim()) {
    parts.push(unquoteTomlKeyPart(current));
  }

  return parts;
}

export function normalizeTomlSectionName(value: string): string {
  return splitTomlDottedKey(value).map((part) => part.trim()).filter(Boolean).join('.');
}

export function findTomlSectionRanges(content: string): TomlSectionRange[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const headers: Array<{ line: number; name: string }> = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(SECTION_HEADER_REGEX);
    if (!match) continue;
    headers.push({
      line: index,
      name: normalizeTomlSectionName(match[1]),
    });
  }

  const ranges: TomlSectionRange[] = [];
  for (let index = 0; index < headers.length; index += 1) {
    const start = headers[index].line;
    const endExclusive = index + 1 < headers.length ? headers[index + 1].line : lines.length;
    ranges.push({
      name: headers[index].name,
      startLine: start,
      endLine: endExclusive - 1,
    });
  }

  return ranges;
}

export function validateTomlDocument(content: string, filePath = 'config.toml'): void {
  const lines = content.replace(/\r\n/g, '\n').split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    if (!trimmed.startsWith('[')) {
      continue;
    }
    if (SECTION_HEADER_REGEX.test(trimmed) || ARRAY_HEADER_REGEX.test(trimmed)) {
      continue;
    }
    throw new Error(
      `Config file at ${filePath} contains malformed TOML near line ${index + 1}: ${trimmed}`
    );
  }
}

export function quoteTomlKey(value: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

export function tomlString(value: string): string {
  return JSON.stringify(value);
}
