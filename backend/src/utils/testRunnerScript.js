/**
 * Test Runner Script Injection Utility
 *
 * Injects a reference to the test runner script into preview iframes.
 * The actual script is served as a separate file to avoid escaping issues
 * that can occur with inline script injection.
 *
 * Communication Protocol (handled by atlas-test-runner.js):
 * - Parent -> Iframe: { type: 'atlas-test-run', test: TestCase }
 * - Parent -> Iframe: { type: 'atlas-test-stop' }
 * - Parent -> Iframe: { type: 'atlas-test-validate-selector', selector: string }
 * - Iframe -> Parent: { type: 'atlas-test-step-result', stepIndex, status, actual?, error? }
 * - Iframe -> Parent: { type: 'atlas-test-complete', result: TestResult }
 * - Iframe -> Parent: { type: 'atlas-test-ready' }
 * - Iframe -> Parent: { type: 'atlas-test-selector-validation', selector, matches, count }
 */

/**
 * Inject the test runner script into HTML
 * Uses an external script file to avoid inline escaping issues
 * @param {string} html - The HTML content
 * @param {string} scriptUrl - Optional URL for the test runner script (defaults to /atlas-test-runner.js)
 * @returns {string} - HTML with test runner script tag injected
 */
export const injectTestRunnerScript = (html, scriptUrl = '/atlas-test-runner.js') => {
  if (!html || html.includes('data-atlas-test-runner="true"')) {
    return html;
  }
  // Use external script to avoid escaping issues with inline code
  const injection = `<script data-atlas-test-runner="true" src="${scriptUrl}"></script>`;
  if (html.includes('</head>')) {
    return html.replace('</head>', `${injection}</head>`);
  }
  if (html.includes('</body>')) {
    return html.replace('</body>', `${injection}</body>`);
  }
  return `${injection}${html}`;
};
