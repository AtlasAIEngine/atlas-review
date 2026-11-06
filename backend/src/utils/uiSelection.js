const clampText = (value, limit) => {
  if (!value) return '';
  const text = String(value).trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}...`;
};

const clampAttributes = (attributes, maxEntries = 12) => {
  if (!attributes || typeof attributes !== 'object') return null;
  const entries = Object.entries(attributes).slice(0, maxEntries);
  return Object.fromEntries(
    entries.map(([key, value]) => [key, clampText(value, 200)])
  );
};

const normalizeTextField = (value, limit) => {
  if (value === null || value === undefined) return null;
  return clampText(String(value), limit);
};

const UI_EDIT_STYLE_KEYS = new Set([
  'color',
  'backgroundColor',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'textAlign',
  'padding',
  'margin',
  'borderRadius',
]);

const normalizeUiEditStyles = (styles) => {
  if (!styles || typeof styles !== 'object') return null;
  const normalized = {};
  for (const [key, value] of Object.entries(styles)) {
    if (!UI_EDIT_STYLE_KEYS.has(key)) continue;
    if (value === null || value === undefined) continue;
    normalized[key] = clampText(String(value).trim(), 120);
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
};

const normalizeUiSelectionLocator = (locator) => {
  if (!locator || typeof locator !== 'object') return null;
  const normalized = {
    selector: clampText(locator.selector, 300),
    path: clampText(locator.path, 400),
    id: clampText(locator.id, 120),
    dataTestId: clampText(locator.dataTestId, 200),
    ariaLabel: clampText(locator.ariaLabel, 200),
    name: clampText(locator.name, 120),
    role: clampText(locator.role, 80),
    type: clampText(locator.type, 80),
    text: clampText(locator.text, 200),
    placeholder: clampText(locator.placeholder, 200),
  };

  const hasValues = Object.values(normalized).some((value) => value);
  return hasValues ? normalized : null;
};

export const normalizeUiSelection = (selection) => {
  if (!selection || typeof selection !== 'object') return null;
  const normalized = {
    tagName: clampText(selection.tagName, 80),
    elementType: clampText(selection.elementType, 40),
    selector: clampText(selection.selector, 300),
    locator: normalizeUiSelectionLocator(selection.locator),
    text: clampText(selection.text, 600),
    outerHTML: clampText(selection.outerHTML, 2000),
    attributes: clampAttributes(selection.attributes),
    boundingBox: selection.boundingBox && typeof selection.boundingBox === 'object'
      ? {
          x: Number(selection.boundingBox.x) || 0,
          y: Number(selection.boundingBox.y) || 0,
          width: Number(selection.boundingBox.width) || 0,
          height: Number(selection.boundingBox.height) || 0,
          top: Number(selection.boundingBox.top) || 0,
          left: Number(selection.boundingBox.left) || 0,
        }
      : null,
    pageUrl: clampText(selection.pageUrl, 500),
    timestamp: clampText(selection.timestamp, 80),
  };
  const hasContent =
    normalized.tagName ||
    normalized.selector ||
    normalized.locator ||
    normalized.text ||
    normalized.outerHTML;
  return hasContent ? normalized : null;
};

export const normalizeUiEdits = (edits) => {
  if (!edits || typeof edits !== 'object') return null;
  const normalized = {
    text: normalizeTextField(edits.text, 800),
    placeholder: normalizeTextField(edits.placeholder, 400),
    value: normalizeTextField(edits.value, 400),
    styles: normalizeUiEditStyles(edits.styles),
  };

  const hasEdits =
    normalized.text !== null ||
    normalized.placeholder !== null ||
    normalized.value !== null ||
    (normalized.styles && Object.keys(normalized.styles).length > 0);

  return hasEdits ? normalized : null;
};

export const formatUiSelectionContext = (selection) => {
  if (!selection) return '';
  const lines = ['UI Selection Context:'];

  if (selection.selector) lines.push(`- Selector: ${selection.selector}`);
  if (selection.tagName) lines.push(`- Tag: ${selection.tagName}`);
  if (selection.pageUrl) lines.push(`- Page: ${selection.pageUrl}`);
  if (selection.text) lines.push(`- Text: ${selection.text}`);
  if (selection.attributes && Object.keys(selection.attributes).length > 0) {
    const attrs = Object.entries(selection.attributes)
      .map(([key, value]) => `${key}="${value}"`)
      .join(' ');
    lines.push(`- Attributes: ${attrs}`);
  }
  if (selection.boundingBox) {
    const box = selection.boundingBox;
    lines.push(
      `- Bounding box: x=${box.x}, y=${box.y}, w=${box.width}, h=${box.height}`
    );
  }
  if (selection.outerHTML) {
    lines.push('HTML:');
    lines.push(selection.outerHTML);
  }

  return lines.join('\n');
};

export const formatUiEditsContext = (edits) => {
  if (!edits) return '';
  const lines = ['UI Local Edits:'];

  if (edits.text !== null && edits.text !== undefined) {
    lines.push(`- Text: ${edits.text || '[empty]'}`);
  }
  if (edits.value !== null && edits.value !== undefined) {
    lines.push(`- Value: ${edits.value || '[empty]'}`);
  }
  if (edits.placeholder !== null && edits.placeholder !== undefined) {
    lines.push(`- Placeholder: ${edits.placeholder || '[empty]'}`);
  }
  if (edits.styles && Object.keys(edits.styles).length > 0) {
    const styleEntries = Object.entries(edits.styles)
      .map(([key, value]) => `${key}=${value || '[empty]'}`)
      .join(', ');
    lines.push(`- Styles: ${styleEntries}`);
  }

  return lines.join('\n');
};
