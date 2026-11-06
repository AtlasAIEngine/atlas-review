/**
 * Test Recorder Script Injection Utility
 *
 * Injects a reference to the recorder script into preview iframes.
 * The actual script is served as a separate file to avoid escaping issues
 * that can occur with inline script injection.
 *
 * Communication Protocol (handled by atlas-recorder.js):
 * - Parent -> Iframe: { type: 'atlas-record-start' }
 * - Parent -> Iframe: { type: 'atlas-record-stop' }
 * - Iframe -> Parent: { type: 'atlas-record-action', action, selector, value?, elementInfo, timestamp }
 * - Iframe -> Parent: { type: 'atlas-recorder-ready' }
 * - Iframe -> Parent: { type: 'atlas-recorder-started' }
 * - Iframe -> Parent: { type: 'atlas-recorder-stopped' }
 */

/**
 * Inject the recorder script into HTML
 * Uses an external script file to avoid inline escaping issues
 * @param {string} html - The HTML content
 * @param {string} scriptUrl - Optional URL for the recorder script (defaults to /atlas-recorder.js)
 * @returns {string} - HTML with recorder script tag injected
 */
export const injectRecorderScript = (html, scriptUrl = '/atlas-recorder.js') => {
  if (!html || html.includes('data-atlas-recorder="true"')) {
    return html;
  }
  // Use external script to avoid escaping issues with inline code
  const injection = `<script data-atlas-recorder="true" src="${scriptUrl}"></script>`;
  if (html.includes('</head>')) {
    return html.replace('</head>', `${injection}</head>`);
  }
  if (html.includes('</body>')) {
    return html.replace('</body>', `${injection}</body>`);
  }
  return `${injection}${html}`;
};
