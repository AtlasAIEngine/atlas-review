/**
 * Parameter Converter for SQL Queries
 * Converts PostgreSQL-style $N placeholders to SQLite ? placeholders
 *
 * Handles edge cases:
 * - Correctly parses $10+ (multi-digit) placeholders
 * - Skips placeholders inside strings ('...$1...' or "...$1...")
 * - Reorders parameters if necessary
 */

/**
 * Convert PostgreSQL $1, $2, ... placeholders to SQLite ? placeholders
 * Also reorders parameters array if needed
 *
 * @param {string} sql - SQL query with $N placeholders
 * @param {Array} params - Query parameters
 * @returns {{ sql: string, params: Array }} Converted query and reordered params
 */
export function convertParams(sql, params = []) {
  if (!params || params.length === 0) {
    // No parameters, just remove any $N placeholders (shouldn't exist)
    return { sql, params: [] };
  }

  const result = {
    sql: '',
    params: []
  };

  // Track which parameters are used and in what order
  const usedParams = [];
  let i = 0;
  const len = sql.length;
  let inSingleQuote = false;
  let inDoubleQuote = false;

  while (i < len) {
    const char = sql[i];

    // Handle string literals - track quote state
    if (char === "'" && !inDoubleQuote) {
      // Check for escaped quote ('')
      if (i + 1 < len && sql[i + 1] === "'") {
        result.sql += "''";
        i += 2;
        continue;
      }
      inSingleQuote = !inSingleQuote;
      result.sql += char;
      i++;
      continue;
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      result.sql += char;
      i++;
      continue;
    }

    // Inside a string literal - copy as-is
    if (inSingleQuote || inDoubleQuote) {
      result.sql += char;
      i++;
      continue;
    }

    // Check for $ placeholder
    if (char === '$') {
      // Try to parse the number after $
      let numStr = '';
      let j = i + 1;
      while (j < len && sql[j] >= '0' && sql[j] <= '9') {
        numStr += sql[j];
        j++;
      }

      if (numStr.length > 0) {
        const paramIndex = parseInt(numStr, 10) - 1; // $1 -> index 0

        if (paramIndex >= 0 && paramIndex < params.length) {
          // Replace $N with ?
          result.sql += '?';
          usedParams.push(params[paramIndex]);
          i = j;
          continue;
        }
      }
    }

    // Regular character
    result.sql += char;
    i++;
  }

  result.params = usedParams;
  return result;
}

/**
 * Parse query to find all $N placeholders and their order
 * @param {string} sql - SQL query
 * @returns {number[]} Array of parameter indices found (0-based)
 */
export function findPlaceholders(sql) {
  const placeholders = [];
  let i = 0;
  const len = sql.length;
  let inSingleQuote = false;
  let inDoubleQuote = false;

  while (i < len) {
    const char = sql[i];

    if (char === "'" && !inDoubleQuote) {
      if (i + 1 < len && sql[i + 1] === "'") {
        i += 2;
        continue;
      }
      inSingleQuote = !inSingleQuote;
      i++;
      continue;
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      i++;
      continue;
    }

    if (inSingleQuote || inDoubleQuote) {
      i++;
      continue;
    }

    if (char === '$') {
      let numStr = '';
      let j = i + 1;
      while (j < len && sql[j] >= '0' && sql[j] <= '9') {
        numStr += sql[j];
        j++;
      }

      if (numStr.length > 0) {
        const paramIndex = parseInt(numStr, 10) - 1;
        placeholders.push(paramIndex);
        i = j;
        continue;
      }
    }

    i++;
  }

  return placeholders;
}

export default {
  convertParams,
  findPlaceholders
};
