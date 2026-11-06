#!/usr/bin/env node

/**
 * Claude Code CLI Wrapper
 * Integrates with actual Claude Code CLI for real AI-powered development
 */

import { spawn, execSync } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

/**
 * Find the Claude CLI path
 * Tries common locations and falls back to PATH lookup
 */
function findClaudePath() {
  const homeDir = process.env.HOME || os.homedir();
  // Priority order for Claude CLI paths
  const candidates = [
    path.join(homeDir, '.local', 'bin', 'claude'),  // User local installation (most reliable)
    '/opt/homebrew/bin/claude',               // Homebrew on Apple Silicon
    '/usr/local/bin/claude',                  // Homebrew on Intel or manual install
  ];

  // Check each candidate
  for (const candidate of candidates) {
    try {
      require('fs').accessSync(candidate, require('fs').constants.X_OK);
      return candidate;
    } catch {
      // Not found or not executable, try next
    }
  }

  // Fallback to PATH lookup
  try {
    const result = execSync('which claude', { encoding: 'utf8' }).trim();
    if (result) return result;
  } catch {
    // which failed
  }

  throw new Error('Claude CLI not found. Please install Claude Code CLI.');
}

// Parse command line arguments
const args = process.argv.slice(2);
let projectPath = '.';
let message = '';
let format = 'json';
let conversationHistory = [];
let attachments = [];
let selectedModel = ''; // Empty means use Claude CLI's default
let permissionMode = ''; // Empty means use --dangerously-skip-permissions

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--project-path' && args[i + 1]) {
    projectPath = args[i + 1];
    i++;
  } else if (args[i] === '--message' && args[i + 1]) {
    message = args[i + 1];
    i++;
  } else if (args[i] === '--format' && args[i + 1]) {
    format = args[i + 1];
    i++;
  } else if (args[i] === '--model' && args[i + 1]) {
    selectedModel = args[i + 1];
    i++;
  } else if (args[i] === '--history' && args[i + 1]) {
    try {
      conversationHistory = JSON.parse(args[i + 1]);
    } catch (error) {
      console.error('Failed to parse conversation history:', error.message);
    }
    i++;
  } else if (args[i] === '--attachments' && args[i + 1]) {
    try {
      attachments = JSON.parse(args[i + 1]);
    } catch (error) {
      console.error('Failed to parse attachments:', error.message);
    }
    i++;
  } else if (args[i] === '--permission-mode' && args[i + 1]) {
    permissionMode = args[i + 1];
    i++;
  }
}

/**
 * Convert image file to base64 content block
 */
async function imageToContentBlock(filePath) {
  try {
    // Read file
    const fileBuffer = await fs.readFile(filePath);
    const base64Data = fileBuffer.toString('base64');

    // Determine MIME type from extension
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
    };
    const mediaType = mimeTypes[ext] || 'image/jpeg';

    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: mediaType,
        data: base64Data,
      },
    };
  } catch (error) {
    console.error(`Failed to read image ${filePath}:`, error.message);
    return null;
  }
}

/**
 * Main wrapper function - integrates with real Claude CLI
 */
async function main() {
  try {
    // Generate or use existing session ID for conversation continuity
    const sessionId = randomUUID();

    // Build content blocks if attachments are provided
    let hasAttachments = attachments && attachments.length > 0;
    let contentBlocks = [];

    if (hasAttachments) {
      // Convert attachments to image content blocks
      for (const attachmentPath of attachments) {
        const imageBlock = await imageToContentBlock(attachmentPath);
        if (imageBlock) {
          contentBlocks.push(imageBlock);
        }
      }

      // Add text message as final content block
      contentBlocks.push({
        type: 'text',
        text: message,
      });
    }

    // Prepare Claude CLI command
    const claudeArgs = [
      '--print',                          // Non-interactive mode
      '--output-format', 'stream-json',   // Streaming JSON output
      '--verbose',                        // Required for stream-json with --print
      '--session-id', sessionId,          // Session continuity
    ];

    // Add permission mode or fall back to dangerously-skip-permissions
    if (permissionMode) {
      claudeArgs.push('--permission-mode', permissionMode);
      console.error(`Using permission mode: ${permissionMode}`);
    } else {
      claudeArgs.push('--dangerously-skip-permissions');
    }

    // Add model selection if specified
    if (selectedModel) {
      claudeArgs.push('--model', selectedModel);
      console.error(`Using model: ${selectedModel}`);
    }

    // Add input format for multimodal messages
    if (hasAttachments) {
      claudeArgs.push('--input-format', 'stream-json');
    } else {
      // For text-only messages, pass message as argument
      claudeArgs.push(message);
    }

    // Spawn Claude Code CLI process
    // Dynamically find the Claude CLI path
    const claudePath = findClaudePath();
    console.error(`Using Claude CLI at: ${claudePath}`);
    const claudeProcess = spawn(claudePath, claudeArgs, {
      cwd: projectPath,  // Claude auto-loads CLAUDE.md from this directory
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let responseText = '';
    let tokensUsed = 0;
    let model = 'claude-sonnet-4-5';

    // Handle stdout (streaming JSON responses)
    claudeProcess.stdout.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.split('\n').filter(line => line.trim());

      for (const line of lines) {
        try {
          const event = JSON.parse(line);

          // Handle different event types from Claude CLI's stream-json format
          switch (event.type) {
            case 'system':
              // Initialization event - contains model info
              if (event.model) {
                model = event.model;
              }
              break;

            case 'assistant':
              // Assistant response event - contains the actual message
              if (event.message) {
                model = event.message.model || model;
                // Extract text from content array - ONLY text content
                if (event.message.content && Array.isArray(event.message.content)) {
                  for (const content of event.message.content) {
                    if (content.type === 'text' && content.text) {
                      // Clear any previous responseText and use ONLY this text
                      // (in case there are multiple assistant events)
                      responseText = content.text;
                    }
                  }
                }
                // Extract token usage
                if (event.message.usage && event.message.usage.output_tokens) {
                  tokensUsed = event.message.usage.output_tokens;
                }
              }
              break;

            case 'result':
              // Final result event - can also extract usage here
              if (event.usage && event.usage.output_tokens) {
                tokensUsed = event.usage.output_tokens;
              }
              if (event.modelUsage) {
                const modelUsage = event.modelUsage['claude-sonnet-4-6']
                  || event.modelUsage['claude-sonnet-4-5-20250929'];
                if (modelUsage) {
                  tokensUsed = modelUsage.outputTokens || tokensUsed;
                }
              }
              break;
          }
        } catch (error) {
          // Ignore non-JSON lines (don't add them to response)
          // The verbose output contains many non-JSON debug lines that we should skip
        }
      }
    });

    // Handle stderr
    claudeProcess.stderr.on('data', (data) => {
      console.error('Claude CLI stderr:', data.toString());
    });

    // Wait for process to complete
    await new Promise((resolve, reject) => {
      claudeProcess.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Claude CLI exited with code ${code}`));
        }
      });

      claudeProcess.on('error', (error) => {
        reject(new Error(`Failed to spawn Claude CLI: ${error.message}`));
      });

      // Send conversation history via stdin if provided
      if (conversationHistory && conversationHistory.length > 0) {
        for (const msg of conversationHistory) {
          const streamEvent = JSON.stringify({
            type: msg.role === 'user' ? 'user' : 'assistant',
            content: msg.content
          }) + '\n';
          claudeProcess.stdin.write(streamEvent);
        }
      }

      // Send multimodal message via stdin if attachments are present
      if (hasAttachments && contentBlocks.length > 0) {
        const userMessage = JSON.stringify({
          type: 'user',
          content: contentBlocks
        }) + '\n';
        claudeProcess.stdin.write(userMessage);
      }

      // Close stdin to signal we're done sending input
      claudeProcess.stdin.end();
    });

    // Output response in requested format
    if (format === 'json') {
      const output = {
        message: responseText.trim() || 'No response from Claude',
        tokensUsed: tokensUsed || estimateTokens(message + responseText),
        model: model,
        timestamp: new Date().toISOString(),
      };

      console.log(JSON.stringify(output));
    } else {
      console.log(responseText.trim() || 'No response from Claude');
    }

    process.exit(0);
  } catch (error) {
    console.error(`Error: ${error.message}`);

    // Return error as JSON if format is json
    if (format === 'json') {
      console.log(JSON.stringify({
        message: `Error: ${error.message}`,
        tokensUsed: 0,
        model: 'error',
        timestamp: new Date().toISOString(),
      }));
    }

    process.exit(1);
  }
}

/**
 * Estimate token count (rough approximation)
 */
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

// Run the wrapper
main().catch((error) => {
  console.error(`Fatal error: ${error.message}`);
  process.exit(1);
});
