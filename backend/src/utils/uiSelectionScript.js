/**
 * UI Selection Script Injection Utility
 *
 * Injects a reference to the UI selection script into preview iframes.
 * The actual script is served as a separate file to avoid escaping issues
 * that can occur with inline script injection.
 */

/**
 * Inject the UI selection script into HTML
 * Uses an external script file to avoid inline escaping issues
 * @param {string} html - The HTML content
 * @param {string} scriptUrl - Optional URL for the selection script (defaults to /atlas-ui-selection.js)
 * @returns {string} - HTML with UI selection script tag injected
 */
export const injectUiSelectionScript = (html, scriptUrl = '/atlas-ui-selection.js?v=20260323-foreign-object') => {
  if (!html || html.includes('data-atlas-ui-select="true"')) {
    return html;
  }
  // Use external script to avoid escaping issues with inline code
  const injection = `<script data-atlas-ui-select="true" src="${scriptUrl}"></script>`;
  if (html.includes('</head>')) {
    return html.replace('</head>', `${injection}</head>`);
  }
  if (html.includes('</body>')) {
    return html.replace('</body>', `${injection}</body>`);
  }
  return `${injection}${html}`;
};
