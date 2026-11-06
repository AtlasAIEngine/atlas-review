/**
 * Encryption Utilities
 * Provides AES-256-GCM encryption/decryption for sensitive data like GitHub tokens
 *
 * Security features:
 * - AES-256-GCM authenticated encryption (AEAD)
 * - Random IV generation for each encryption
 * - Authentication tag verification on decryption
 * - Base64 encoding for storage compatibility
 *
 * Environment Requirements:
 * - ENCRYPTION_KEY: 32-byte base64-encoded key (generate with: openssl rand -base64 32)
 */

import crypto from 'crypto';

// Encryption configuration
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16; // 128 bits for GCM
const AUTH_TAG_LENGTH = 16; // 128 bits authentication tag
const KEY_LENGTH = 32; // 256 bits key

/**
 * Get encryption key from environment
 * @returns {Buffer} 32-byte encryption key
 * @throws {Error} If ENCRYPTION_KEY is not set or invalid
 */
function getEncryptionKey() {
  const envKey = process.env.ENCRYPTION_KEY;

  if (!envKey) {
    throw new Error('ENCRYPTION_KEY environment variable is not set. Generate with: openssl rand -base64 32');
  }

  try {
    const keyBuffer = Buffer.from(envKey, 'base64');

    if (keyBuffer.length !== KEY_LENGTH) {
      throw new Error(`ENCRYPTION_KEY must be ${KEY_LENGTH} bytes (base64 encoded). Current length: ${keyBuffer.length}`);
    }

    return keyBuffer;
  } catch (error) {
    throw new Error(`Invalid ENCRYPTION_KEY format: ${error.message}`);
  }
}

/**
 * Encrypt sensitive data using AES-256-GCM
 *
 * @param {string} plaintext - Data to encrypt
 * @returns {string} Encrypted data in format: iv:authTag:ciphertext (all base64 encoded)
 * @throws {Error} If encryption fails
 *
 * @example
 * const encrypted = encrypt('my-secret-token');
 * // Returns: "k2HvR3JlYXR...==:aGVsbG93b3Js...==:ZW5jcnlwdGVk...=="
 */
export function encrypt(plaintext) {
  try {
    if (!plaintext || typeof plaintext !== 'string') {
      throw new Error('Plaintext must be a non-empty string');
    }

    const key = getEncryptionKey();
    const iv = crypto.randomBytes(IV_LENGTH);

    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let ciphertext = cipher.update(plaintext, 'utf8', 'base64');
    ciphertext += cipher.final('base64');

    const authTag = cipher.getAuthTag();

    // Combine IV, auth tag, and ciphertext for storage
    return `${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext}`;
  } catch (error) {
    throw new Error(`Encryption failed: ${error.message}`);
  }
}

/**
 * Decrypt data encrypted with AES-256-GCM
 *
 * @param {string} encryptedData - Encrypted data in format: iv:authTag:ciphertext
 * @returns {string} Decrypted plaintext
 * @throws {Error} If decryption fails or authentication tag verification fails
 *
 * @example
 * const decrypted = decrypt('k2HvR3JlYXR...==:aGVsbG93b3Js...==:ZW5jcnlwdGVk...==');
 * // Returns: "my-secret-token"
 */
export function decrypt(encryptedData) {
  try {
    if (!encryptedData || typeof encryptedData !== 'string') {
      throw new Error('Encrypted data must be a non-empty string');
    }

    const parts = encryptedData.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted data format. Expected format: iv:authTag:ciphertext');
    }

    const [ivBase64, authTagBase64, ciphertext] = parts;

    const key = getEncryptionKey();
    const iv = Buffer.from(ivBase64, 'base64');
    const authTag = Buffer.from(authTagBase64, 'base64');

    if (iv.length !== IV_LENGTH) {
      throw new Error(`Invalid IV length: ${iv.length}, expected ${IV_LENGTH}`);
    }

    if (authTag.length !== AUTH_TAG_LENGTH) {
      throw new Error(`Invalid auth tag length: ${authTag.length}, expected ${AUTH_TAG_LENGTH}`);
    }

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let plaintext = decipher.update(ciphertext, 'base64', 'utf8');
    plaintext += decipher.final('utf8');

    return plaintext;
  } catch (error) {
    throw new Error(`Decryption failed: ${error.message}`);
  }
}

/**
 * Hash data using SHA-256 (for non-reversible hashing)
 * Useful for creating identifiers or checksums
 *
 * @param {string} data - Data to hash
 * @returns {string} Hex-encoded SHA-256 hash
 *
 * @example
 * const hash = hashData('my-data');
 * // Returns: "3f786850e387550fdab836ed7e6dc881de23001b"
 */
export function hashData(data) {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

/**
 * Generate a secure random string
 * Useful for generating secrets, session IDs, etc.
 *
 * @param {number} length - Length of random string in bytes (default: 32)
 * @returns {string} Base64-encoded random string
 *
 * @example
 * const secret = generateRandomString(32);
 * // Returns: "k2HvR3JlYXRvbzd0aGVzZWNyZXQ="
 */
export function generateRandomString(length = 32) {
  return crypto.randomBytes(length).toString('base64');
}

/**
 * Validate encryption key format
 * Useful for startup checks
 *
 * @returns {boolean} True if encryption key is valid
 */
export function validateEncryptionKey() {
  try {
    getEncryptionKey();
    return true;
  } catch (error) {
    console.error('Encryption key validation failed:', error.message);
    return false;
  }
}

/**
 * Test encryption/decryption round-trip
 * Useful for verifying encryption is working correctly
 *
 * @returns {Object} Test result with success flag and any error message
 */
export function testEncryption() {
  try {
    const testData = 'test-secret-token-' + Date.now();
    const encrypted = encrypt(testData);
    const decrypted = decrypt(encrypted);

    if (decrypted !== testData) {
      return {
        success: false,
        error: 'Decrypted data does not match original'
      };
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

export default {
  encrypt,
  decrypt,
  hashData,
  generateRandomString,
  validateEncryptionKey,
  testEncryption
};
