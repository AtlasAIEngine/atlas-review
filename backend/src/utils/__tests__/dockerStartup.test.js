import { describe, it, expect } from 'vitest';
import { isDockerUnavailableError, shouldContinueWithoutDocker } from '../dockerStartup.js';

describe('dockerStartup helpers', () => {
  describe('isDockerUnavailableError', () => {
    it('treats known Docker transport errors as unavailable', () => {
      expect(isDockerUnavailableError({ code: 'ENOENT' })).toBe(true);
      expect(isDockerUnavailableError({ code: 'econnrefused' })).toBe(true);
      expect(isDockerUnavailableError({ code: 'EACCES' })).toBe(true);
    });

    it('treats known Docker daemon messages as unavailable', () => {
      expect(isDockerUnavailableError({ message: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock' })).toBe(true);
      expect(isDockerUnavailableError({ message: 'Error: docker.sock missing' })).toBe(true);
      expect(isDockerUnavailableError({ message: 'docker daemon is not running' })).toBe(true);
    });

    it('does not classify unrelated errors as Docker unavailable', () => {
      expect(isDockerUnavailableError({ code: 'ETIMEDOUT', message: 'network timeout' })).toBe(false);
      expect(isDockerUnavailableError(new Error('something else failed'))).toBe(false);
      expect(isDockerUnavailableError(null)).toBe(false);
    });
  });

  describe('shouldContinueWithoutDocker', () => {
    const dockerUnavailable = { code: 'ENOENT', message: 'docker.sock not found' };

    it('allows continuation in non-production when docker is optional and unavailable', () => {
      expect(shouldContinueWithoutDocker({
        nodeEnv: 'development',
        dockerRequired: 'false',
        error: dockerUnavailable,
      })).toBe(true);
      expect(shouldContinueWithoutDocker({
        nodeEnv: 'test',
        dockerRequired: undefined,
        error: dockerUnavailable,
      })).toBe(true);
    });

    it('disallows continuation when docker is required', () => {
      expect(shouldContinueWithoutDocker({
        nodeEnv: 'development',
        dockerRequired: 'true',
        error: dockerUnavailable,
      })).toBe(false);
      expect(shouldContinueWithoutDocker({
        nodeEnv: 'development',
        dockerRequired: 'TRUE',
        error: dockerUnavailable,
      })).toBe(false);
    });

    it('disallows continuation in production even for docker-unavailable errors', () => {
      expect(shouldContinueWithoutDocker({
        nodeEnv: 'production',
        dockerRequired: 'false',
        error: dockerUnavailable,
      })).toBe(false);
    });

    it('disallows continuation for non-docker errors', () => {
      expect(shouldContinueWithoutDocker({
        nodeEnv: 'development',
        dockerRequired: 'false',
        error: { code: 'ETIMEDOUT', message: 'network timeout' },
      })).toBe(false);
    });
  });
});
