#!/usr/bin/env node

import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const desktopDir = dirname(__dirname);

function stripWrappingQuotes(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === '\'' && last === '\'')) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function stripInlineComment(value) {
  if (!value) return value;
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith('"') || trimmed.startsWith('\'')) {
    return trimmed;
  }
  if (trimmed.startsWith('#')) {
    return '';
  }
  const commentIndex = trimmed.search(/\s+#/);
  return commentIndex >= 0 ? trimmed.slice(0, commentIndex).trimEnd() : trimmed;
}

export function parseEnvFile(content) {
  const entries = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const separator = line.indexOf('=');
    if (separator <= 0) continue;

    const key = line.slice(0, separator).trim();
    if (!key) continue;

    const rawValue = line.slice(separator + 1).trim();
    const value = stripWrappingQuotes(stripInlineComment(rawValue));
    entries.push([key, value]);
  }
  return entries;
}

export function loadDesktopLocalEnv() {
  const envPaths = [
    join(desktopDir, '.env.local'),
    join(desktopDir, '.env'),
  ];

  for (const envPath of envPaths) {
    if (!existsSync(envPath)) continue;
    const entries = parseEnvFile(readFileSync(envPath, 'utf8'));
    for (const [key, value] of entries) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}
