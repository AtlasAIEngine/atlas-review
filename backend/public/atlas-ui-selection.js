/**
 * Atlas UI Selection Script
 * Injected into preview iframes to enable element selection and editing
 */

(function () {
  var ATLAS_UI_SELECTION_VERSION = '20260323-foreign-object';

  // Allow re-injection if version changed (old script may be cached).
  // Only skip if the exact same version already ran.
  if (window.__atlasUiSelectInjected && window.__atlasUiSelectVersion === ATLAS_UI_SELECTION_VERSION) return;

  // If upgrading from an old version, clean up old overlay elements
  if (window.__atlasUiSelectInjected) {
    document.querySelectorAll('[data-atlas-screenshot]').forEach(function(el) { el.remove(); });
    document.querySelectorAll('[data-atlas-ui-select="highlight"]').forEach(function(el) { el.remove(); });
  }

  window.__atlasUiSelectInjected = true;
  window.__atlasUiSelectVersion = ATLAS_UI_SELECTION_VERSION;

  var enabled = false;
  var highlight = document.createElement('div');
  highlight.setAttribute('data-atlas-ui-select', 'highlight');
  highlight.style.position = 'fixed';
  highlight.style.pointerEvents = 'none';
  highlight.style.border = '2px solid #60A5FA';
  highlight.style.background = 'rgba(96, 165, 250, 0.15)';
  highlight.style.zIndex = '2147483647';
  highlight.style.top = '0';
  highlight.style.left = '0';
  highlight.style.width = '0';
  highlight.style.height = '0';
  highlight.style.display = 'none';
  document.documentElement.appendChild(highlight);
  var selectedElement = null;
  var selectedElementType = null;
  var selectedSnapshot = null;
  var selectedSelector = '';
  var selectedLocator = null;
  var hasEdits = false;
  var persistedStyleRules = {};
  var styleTag = null;
  var persistedEditsCache = null;
  var applyScheduled = false;
  var applyObserver = null;
  var historyPatched = false;
  var liveEditPayload = null;
  var liveEditLocator = null;
  var liveEditLastUpdate = 0;
  var PREVIEW_PROXY_COOKIE = 'atlas_preview_proxy';
  var STYLE_KEYS = [
    'color',
    'backgroundColor',
    'fontSize',
    'fontWeight',
    'lineHeight',
    'textAlign',
    'padding',
    'margin',
    'borderRadius',
  ];
  var LENGTH_STYLE_KEYS = {
    padding: true,
    margin: true,
    fontSize: true,
    borderRadius: true,
  };

  function clampText(value, limit) {
    if (!value) return '';
    var text = String(value).trim();
    if (text.length <= limit) return text;
    return text.slice(0, limit) + '...';
  }

  function escapeCssIdentifier(value) {
    if (!value) return '';
    if (window.CSS && typeof window.CSS.escape === 'function') {
      return window.CSS.escape(value);
    }
    return value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  function escapeAttributeValue(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function normalizeSelector(selector) {
    if (!selector) return '';
    if (selector.indexOf('\\') !== -1) return selector;
    var parts = selector.split(' > ');
    var normalizedParts = parts.map(function (part) {
      if (!part) return part;
      var hashIndex = part.indexOf('#');
      if (hashIndex >= 0) {
        var tag = part.slice(0, hashIndex);
        var id = part.slice(hashIndex + 1);
        return tag + '#' + escapeCssIdentifier(id);
      }
      var segments = part.split('.');
      var tagName = segments.shift() || '';
      var classes = segments
        .filter(function (segment) { return !!segment; })
        .map(escapeCssIdentifier);
      return tagName + (classes.length ? '.' + classes.join('.') : '');
    });
    return normalizedParts.join(' > ');
  }

  function querySelectorSafe(selector) {
    if (!selector) return null;
    try {
      return document.querySelector(selector);
    } catch (error) {
      // Try normalized selector fallback.
    }
    var normalized = normalizeSelector(selector);
    if (normalized && normalized !== selector) {
      try {
        return document.querySelector(normalized);
      } catch (error) {}
    }
    return null;
  }

  function getAttributes(element) {
    var attrs = {};
    if (!element || !element.attributes) return attrs;
    var maxAttrs = 12;
    for (var i = 0; i < element.attributes.length && i < maxAttrs; i += 1) {
      var attr = element.attributes[i];
      if (!attr || !attr.name) continue;
      attrs[attr.name] = clampText(attr.value, 200);
    }
    return attrs;
  }

  function getComputedStyles(element) {
    var result = {};
    if (!element || !window.getComputedStyle) return result;
    var styles = window.getComputedStyle(element);
    for (var i = 0; i < STYLE_KEYS.length; i += 1) {
      var key = STYLE_KEYS[i];
      var value = styles[key] || styles.getPropertyValue(key);
      if (value) {
        result[key] = clampText(value.trim(), 120);
      }
    }
    return result;
  }

  function getElementType(element) {
    if (!element || !element.tagName) return 'other';
    var tagName = element.tagName.toLowerCase();
    if (tagName === 'input') return 'input';
    if (tagName === 'textarea') return 'textarea';
    if (tagName === 'img') return 'image';
    if (element.isContentEditable) return 'text';
    if (element.childElementCount === 0) {
      var text = element.innerText || element.textContent || '';
      if (text.trim()) return 'text';
    }
    return 'other';
  }

  function getEditableText(element, elementType) {
    if (elementType !== 'text') return '';
    var text = element.innerText || element.textContent || '';
    return clampText(text, 600);
  }

  function captureSnapshot(element) {
    if (!element) return null;
    return {
      text: element.textContent || '',
      value: 'value' in element ? element.value : '',
      placeholder: element.getAttribute ? element.getAttribute('placeholder') || '' : '',
      style: element.getAttribute ? element.getAttribute('style') || '' : '',
    };
  }

  function applyEditsToElement(element, payload) {
    if (!element || !payload) return;
    var elementType = getElementType(element);

    if (payload.text !== undefined && payload.text !== null) {
      element.textContent = String(payload.text);
    }

    if (payload.value !== undefined && payload.value !== null && 'value' in element) {
      element.value = String(payload.value);
    }

    if (payload.placeholder !== undefined && payload.placeholder !== null && element.setAttribute) {
      element.setAttribute('placeholder', String(payload.placeholder));
    }

    if (payload.styles && typeof payload.styles === 'object') {
      for (var key in payload.styles) {
        if (!Object.prototype.hasOwnProperty.call(payload.styles, key)) continue;
        if (STYLE_KEYS.indexOf(key) === -1) continue;
        element.style[key] = normalizeStyleValue(key, payload.styles[key]);
      }
    }
  }

  function ensureStyleTag() {
    if (styleTag) return;
    styleTag = document.createElement('style');
    styleTag.setAttribute('data-atlas-ui-edits', 'styles');
    var head = document.head || document.getElementsByTagName('head')[0] || document.documentElement;
    if (head) {
      head.appendChild(styleTag);
    }
  }

  function toKebabCase(value) {
    return value.replace(/[A-Z]/g, function (match) {
      return '-' + match.toLowerCase();
    });
  }

  function normalizeStyleValue(key, value) {
    if (value === null || value === undefined) return '';
    var raw = String(value).trim();
    if (!raw) return '';
    if (!LENGTH_STYLE_KEYS[key]) return raw;
    if (raw.indexOf(' ') !== -1) return raw;
    if (/^-?\d+(\.\d+)?$/.test(raw)) return raw + 'px';
    return raw;
  }

  function rebuildStyleTag() {
    ensureStyleTag();
    if (!styleTag) return;
    var css = '';
    for (var selector in persistedStyleRules) {
      if (!Object.prototype.hasOwnProperty.call(persistedStyleRules, selector)) continue;
      var safeSelector = normalizeSelector(selector);
      var styles = persistedStyleRules[selector];
      if (!styles) continue;
      var declarations = '';
      for (var key in styles) {
        if (!Object.prototype.hasOwnProperty.call(styles, key)) continue;
        if (STYLE_KEYS.indexOf(key) === -1) continue;
        var value = normalizeStyleValue(key, styles[key]);
        if (value === null || value === undefined || value === '') continue;
        declarations += toKebabCase(key) + ':' + value + ' !important;';
      }
      if (!declarations) continue;
      css += safeSelector + '{' + declarations + '}\n';
    }
    styleTag.textContent = css;
  }

  function updateStyleRule(selector, styles) {
    if (!selector || !styles) return;
    persistedStyleRules[selector] = styles;
    rebuildStyleTag();
  }

  function applyEdits(payload) {
    if (!selectedElement || !payload) return;
    if (!selectedSnapshot) {
      selectedSnapshot = captureSnapshot(selectedElement);
    }
    hasEdits = true;
    if (payload) {
      liveEditPayload = Object.assign({}, liveEditPayload || {}, payload);
      liveEditLocator = selectedLocator || { selector: selectedSelector };
      liveEditLastUpdate = Date.now();
    }
    if (payload.styles) {
      var styleSelector =
        selectedSelector ||
        (selectedLocator && (selectedLocator.selector || selectedLocator.path));
      if (styleSelector) {
        updateStyleRule(styleSelector, payload.styles);
      }
    }
    applyEditsToElement(selectedElement, payload);
  }

  function loadPersistedEdits() {
    if (!window.fetch) return;
    var getCookieValue = function (name) {
      if (!document.cookie) return '';
      var parts = document.cookie.split(';');
      for (var i = 0; i < parts.length; i += 1) {
        var part = parts[i].trim();
        if (!part) continue;
        var eqIndex = part.indexOf('=');
        if (eqIndex === -1) continue;
        var key = part.slice(0, eqIndex);
        if (key !== name) continue;
        return part.slice(eqIndex + 1);
      }
      return '';
    };
    var getProjectIdFromCookie = function () {
      var raw = getCookieValue(PREVIEW_PROXY_COOKIE);
      if (!raw) return '';
      var decoded = raw;
      try {
        decoded = decodeURIComponent(raw);
      } catch (err) {
        decoded = raw;
      }
      var parts = decoded.split(':');
      if (parts.length < 2) return '';
      return parts[1];
    };
    var getEditsUrl = function () {
      var path = window.location.pathname || '';
      var previewMatch = path.match(/^\/preview\/([^/]+)/);
      if (previewMatch) {
        return '/preview/' + previewMatch[1] + '/atlas-ui-edits.json';
      }
      var proxyMatch = path.match(/^\/preview-proxy\/(dev|docker)\/([^/]+)/);
      if (proxyMatch) {
        return '/preview/' + proxyMatch[2] + '/atlas-ui-edits.json';
      }
      var cookieProjectId = getProjectIdFromCookie();
      if (cookieProjectId) {
        return '/preview/' + cookieProjectId + '/atlas-ui-edits.json';
      }
      return '/atlas-ui-edits.json';
    };
    var run = function () {
      window.fetch(getEditsUrl(), { cache: 'no-store' })
        .then(function (response) {
          if (!response.ok) return null;
          return response.json();
        })
        .then(function (data) {
          if (!data || !Array.isArray(data.edits)) return;
          persistedEditsCache = data.edits;
          applyPersistedEdits(data.edits);
          startPersistentObservers();
        })
        .catch(function () {});
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', run);
    } else {
      run();
    }
  }

  function resetEdits() {
    if (!selectedElement || !selectedSnapshot) return;
    if (selectedSnapshot.style) {
      selectedElement.setAttribute('style', selectedSnapshot.style);
    } else if (selectedElement.removeAttribute) {
      selectedElement.removeAttribute('style');
    }

    if (selectedElementType === 'text') {
      selectedElement.textContent = selectedSnapshot.text || '';
    }
    if ('value' in selectedElement) {
      selectedElement.value = selectedSnapshot.value || '';
    }
    if (selectedElement.setAttribute) {
      selectedElement.setAttribute('placeholder', selectedSnapshot.placeholder || '');
    }
    hasEdits = false;
    liveEditPayload = null;
    liveEditLocator = null;
    liveEditLastUpdate = 0;
  }

  function getSelector(element) {
    if (!element || !element.tagName) return '';
    var parts = [];
    var current = element;
    var depth = 0;
    while (current && current.tagName && depth < 6) {
      var part = current.tagName.toLowerCase();
      if (current.id) {
        part += '#' + escapeCssIdentifier(current.id);
      } else if (current.classList && current.classList.length > 0) {
        part += '.' + Array.prototype.slice.call(current.classList, 0, 3)
          .map(escapeCssIdentifier)
          .join('.');
      }
      parts.unshift(part);
      current = current.parentElement;
      depth += 1;
    }
    return parts.join(' > ');
  }

  function getNthPath(element) {
    if (!element || !element.tagName) return '';
    var parts = [];
    var current = element;
    var depth = 0;
    while (current && current.tagName && depth < 8) {
      var tag = current.tagName.toLowerCase();
      if (current.id) {
        parts.unshift(tag + '#' + escapeCssIdentifier(current.id));
        break;
      }
      var parent = current.parentElement;
      if (!parent) {
        parts.unshift(tag);
        break;
      }
      var index = 1;
      var sibling = parent.firstElementChild;
      while (sibling) {
        if (sibling.tagName === current.tagName) {
          if (sibling === current) break;
          index += 1;
        }
        sibling = sibling.nextElementSibling;
      }
      parts.unshift(tag + ':nth-of-type(' + index + ')');
      current = parent;
      depth += 1;
    }
    return parts.join(' > ');
  }

  function buildLocator(element, selector) {
    if (!element) return null;
    var locator = {
      selector: selector || getSelector(element),
      path: getNthPath(element),
    };
    if (element.id) locator.id = element.id;
    if (element.getAttribute) {
      var testId =
        element.getAttribute('data-testid') ||
        element.getAttribute('data-test') ||
        element.getAttribute('data-qa') ||
        element.getAttribute('data-cy');
      if (testId) locator.dataTestId = clampText(testId, 200);
      var ariaLabel = element.getAttribute('aria-label');
      if (ariaLabel) locator.ariaLabel = clampText(ariaLabel, 200);
      var name = element.getAttribute('name');
      if (name) locator.name = clampText(name, 120);
      var role = element.getAttribute('role');
      if (role) locator.role = clampText(role, 80);
      var type = element.getAttribute('type');
      if (type) locator.type = clampText(type, 80);
      var placeholder = element.getAttribute('placeholder');
      if (placeholder) locator.placeholder = clampText(placeholder, 200);
    }
    var text = element.innerText || element.textContent || '';
    if (text && text.trim()) {
      locator.text = clampText(text, 200);
    }
    return locator;
  }

  function buildAttributeSelector(tagName, attrName, attrValue) {
    if (!attrName || attrValue === undefined || attrValue === null) return '';
    var tag = tagName ? tagName.toLowerCase() : '';
    var prefix = tag ? tag + '' : '';
    return prefix + '[' + attrName + '="' + escapeAttributeValue(attrValue) + '"]';
  }

  function findElementByText(tagName, text) {
    if (!text) return null;
    var selector = tagName ? tagName.toLowerCase() : '*';
    var nodes = document.querySelectorAll(selector);
    var limit = Math.min(nodes.length, 200);
    var target = text.trim();
    for (var i = 0; i < limit; i += 1) {
      var nodeText = nodes[i].innerText || nodes[i].textContent || '';
      if (nodeText.trim() === target) {
        return nodes[i];
      }
    }
    return null;
  }

  function findElement(entry) {
    if (!entry) return null;
    var selector = entry.selector || (entry.locator && entry.locator.selector) || '';
    var element = querySelectorSafe(selector);
    if (element) return element;

    var locator = entry.locator || {};
    if (locator.id) {
      element = querySelectorSafe('#' + escapeCssIdentifier(locator.id));
      if (element) return element;
    }

    if (locator.dataTestId) {
      var testAttrs = ['data-testid', 'data-test', 'data-qa', 'data-cy'];
      for (var i = 0; i < testAttrs.length; i += 1) {
        var testSelector = buildAttributeSelector(entry.tagName, testAttrs[i], locator.dataTestId);
        element = querySelectorSafe(testSelector);
        if (element) return element;
      }
    }

    if (locator.ariaLabel) {
      element = querySelectorSafe(buildAttributeSelector(entry.tagName, 'aria-label', locator.ariaLabel));
      if (element) return element;
    }

    if (locator.name) {
      element = querySelectorSafe(buildAttributeSelector(entry.tagName, 'name', locator.name));
      if (element) return element;
    }

    if (locator.role) {
      element = querySelectorSafe(buildAttributeSelector(entry.tagName, 'role', locator.role));
      if (element) return element;
    }

    if (locator.placeholder) {
      element = querySelectorSafe(buildAttributeSelector(entry.tagName, 'placeholder', locator.placeholder));
      if (element) return element;
    }

    if (locator.path) {
      element = querySelectorSafe(locator.path);
      if (element) return element;
    }

    if (locator.text) {
      element = findElementByText(entry.tagName, locator.text);
      if (element) return element;
    }

    return null;
  }

  function isEntryMatch(entry, locator) {
    if (!entry || !locator) return false;
    if (entry.selector && locator.selector && entry.selector === locator.selector) return true;
    if (entry.locator && locator.selector && entry.locator.selector === locator.selector) return true;
    if (entry.locator && locator.path && entry.locator.path === locator.path) return true;
    return false;
  }

  function applyLiveEdits() {
    if (!liveEditPayload || !liveEditLocator) return;
    var element = findElement({ selector: liveEditLocator.selector, locator: liveEditLocator });
    if (!element) return;
    applyEditsToElement(element, liveEditPayload);
  }

  function getStyleSelector(entry) {
    if (!entry) return '';
    if (entry.selector) return normalizeSelector(entry.selector);
    if (entry.locator && entry.locator.selector) return normalizeSelector(entry.locator.selector);
    if (entry.locator && entry.locator.path) return entry.locator.path;
    return '';
  }

  function applyPersistedEdits(entries) {
    if (!entries || !entries.length) return;
    for (var i = 0; i < entries.length; i += 1) {
      var entry = entries[i];
      if (!entry || !entry.edits) continue;
      if (liveEditPayload && liveEditLocator && isEntryMatch(entry, liveEditLocator)) {
        continue;
      }
      if (entry.edits.styles) {
        var styleSelector = getStyleSelector(entry);
        if (styleSelector) {
          updateStyleRule(styleSelector, entry.edits.styles);
        }
      }
      var element = findElement(entry);
      if (element) {
        applyEditsToElement(element, entry.edits);
      }
    }
    if (liveEditPayload && liveEditLocator && Date.now() - liveEditLastUpdate < 60000) {
      applyLiveEdits();
    }
  }

  function scheduleApply() {
    if (applyScheduled) return;
    applyScheduled = true;
    window.setTimeout(function () {
      applyScheduled = false;
      if (persistedEditsCache) {
        applyPersistedEdits(persistedEditsCache);
      }
    }, 200);
  }

  function startPersistentObservers() {
    if (window.MutationObserver && !applyObserver) {
      applyObserver = new MutationObserver(function () {
        scheduleApply();
      });
      applyObserver.observe(document.documentElement || document.body, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    }

    if (!historyPatched && window.history && window.history.pushState) {
      historyPatched = true;
      var originalPushState = window.history.pushState;
      var originalReplaceState = window.history.replaceState;
      window.history.pushState = function () {
        var result = originalPushState.apply(this, arguments);
        scheduleApply();
        return result;
      };
      window.history.replaceState = function () {
        var result = originalReplaceState.apply(this, arguments);
        scheduleApply();
        return result;
      };
      window.addEventListener('popstate', scheduleApply);
      window.addEventListener('hashchange', scheduleApply);
    }
  }

  function updateHighlight(rect) {
    if (!rect) return;
    highlight.style.display = 'block';
    highlight.style.top = rect.top + 'px';
    highlight.style.left = rect.left + 'px';
    highlight.style.width = rect.width + 'px';
    highlight.style.height = rect.height + 'px';
  }

  function hideHighlight() {
    highlight.style.display = 'none';
  }

  function buildPayload(element) {
    var elementType = getElementType(element);
    var rawSelector = getSelector(element);
    var selector = normalizeSelector(rawSelector) || rawSelector;
    var locator = buildLocator(element, selector);
    if (selectedElement !== element || !selectedSnapshot) {
      selectedElement = element;
      selectedElementType = elementType;
      selectedSnapshot = captureSnapshot(element);
      selectedSelector = selector;
      selectedLocator = locator;
      liveEditPayload = null;
      liveEditLocator = null;
      liveEditLastUpdate = 0;
      hasEdits = false;
    }

    var rect = element.getBoundingClientRect();
    return {
      tagName: element.tagName ? element.tagName.toLowerCase() : '',
      elementType: elementType,
      selector: selector,
      locator: locator,
      text: clampText(element.innerText || element.textContent || '', 600),
      editableText: getEditableText(element, elementType),
      placeholder: element.getAttribute ? clampText(element.getAttribute('placeholder') || '', 200) : '',
      value: 'value' in element ? clampText(element.value || '', 200) : '',
      computedStyles: getComputedStyles(element),
      outerHTML: clampText(element.outerHTML || '', 2000),
      attributes: getAttributes(element),
      boundingBox: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        top: rect.top,
        left: rect.left,
      },
      pageUrl: window.location.href,
      timestamp: new Date().toISOString(),
    };
  }

  function postSelection(payload) {
    window.parent.postMessage({ type: 'atlas-ui-select', payload: payload }, '*');
  }

  function onMove(event) {
    if (!enabled) return;
    var target = document.elementFromPoint(event.clientX, event.clientY);
    if (!target || target === highlight) return;
    var rect = target.getBoundingClientRect();
    updateHighlight(rect);
  }

  function onClick(event) {
    if (!enabled) return;
    event.preventDefault();
    event.stopPropagation();
    var target = document.elementFromPoint(event.clientX, event.clientY);
    if (!target || target === highlight) return;
    var rect = target.getBoundingClientRect();
    updateHighlight(rect);
    postSelection(buildPayload(target));
  }

  function setEnabled(next) {
    enabled = !!next;
    document.documentElement.style.cursor = enabled ? 'crosshair' : '';
    if (!enabled) {
      hideHighlight();
    }
  }

  // ── Screenshot region capture ──────────────────────────────────────
  var screenshotActive = false;
  var screenshotDragging = false;
  var screenshotStartX = 0;
  var screenshotStartY = 0;

  var screenshotOverlay = document.createElement('div');
  screenshotOverlay.setAttribute('data-atlas-screenshot', 'overlay');
  screenshotOverlay.style.cssText =
    'position:fixed;inset:0;z-index:2147483646;cursor:crosshair;display:none;background:rgba(0,0,0,0.08);';
  document.documentElement.appendChild(screenshotOverlay);

  var screenshotRect = document.createElement('div');
  screenshotRect.setAttribute('data-atlas-screenshot', 'rect');
  screenshotRect.style.cssText =
    'position:fixed;border:2px dashed #22d3ee;background:rgba(34,211,238,0.12);z-index:2147483647;display:none;pointer-events:none;';
  document.documentElement.appendChild(screenshotRect);

  function startScreenshotMode() {
    screenshotActive = true;
    screenshotDragging = false;
    screenshotOverlay.style.display = 'block';
    screenshotRect.style.display = 'none';
    // Disable element selection while screenshotting
    setEnabled(false);
  }

  function stopScreenshotMode() {
    screenshotActive = false;
    screenshotDragging = false;
    screenshotOverlay.style.display = 'none';
    screenshotRect.style.display = 'none';
  }

  function updateScreenshotRect(x1, y1, x2, y2) {
    var left = Math.min(x1, x2);
    var top = Math.min(y1, y2);
    var w = Math.abs(x2 - x1);
    var h = Math.abs(y2 - y1);
    screenshotRect.style.left = left + 'px';
    screenshotRect.style.top = top + 'px';
    screenshotRect.style.width = w + 'px';
    screenshotRect.style.height = h + 'px';
    screenshotRect.style.display = 'block';
  }

  screenshotOverlay.addEventListener('mousedown', function (e) {
    if (!screenshotActive) return;
    e.preventDefault();
    screenshotDragging = true;
    screenshotStartX = e.clientX;
    screenshotStartY = e.clientY;
    updateScreenshotRect(e.clientX, e.clientY, e.clientX, e.clientY);
  });

  screenshotOverlay.addEventListener('mousemove', function (e) {
    if (!screenshotDragging) return;
    updateScreenshotRect(screenshotStartX, screenshotStartY, e.clientX, e.clientY);
  });

  screenshotOverlay.addEventListener('mouseup', function (e) {
    if (!screenshotDragging) return;
    screenshotDragging = false;

    var left = Math.min(screenshotStartX, e.clientX);
    var top = Math.min(screenshotStartY, e.clientY);
    var w = Math.abs(e.clientX - screenshotStartX);
    var h = Math.abs(e.clientY - screenshotStartY);

    // Ignore tiny selections (accidental clicks)
    if (w < 10 || h < 10) {
      screenshotRect.style.display = 'none';
      return;
    }

    // Hide overlays before capture so they don't appear in the screenshot
    screenshotOverlay.style.display = 'none';
    screenshotRect.style.display = 'none';

    // Call through global so newer script versions can replace the function
    (window.__atlasCaptureRegion || captureRegion)(left, top, w, h);
  });

  function loadHtml2CanvasIfNeeded(callback) {
    if (window.html2canvas) {
      callback(null);
      return;
    }
    var script = document.createElement('script');
    script.src = '/html2canvas.min.js';
    script.onload = function () { callback(null); };
    script.onerror = function () { callback(new Error('Failed to load html2canvas')); };
    document.head.appendChild(script);
  }

  function captureRegion(x, y, w, h) {
    loadHtml2CanvasIfNeeded(function (err) {
      if (err || !window.html2canvas) {
        console.error('[AtlasScreenshot] html2canvas not available:', err);
        stopScreenshotMode();
        window.parent.postMessage({ type: 'atlas-screenshot-error', error: 'Could not load screenshot library' }, '*');
        return;
      }

      // Prefer the default canvas renderer in builder screenshots. Chromium's
      // foreignObject path can preserve some layout edge cases, but it also
      // produces color/compositing artifacts for modern UIs in the preview iframe.
      // Render the full body, then manually crop at document coords.
      var scrollLeft = window.scrollX || window.pageXOffset || 0;
      var scrollTop = window.scrollY || window.pageYOffset || 0;
      var vpW = window.innerWidth || document.documentElement.clientWidth;
      var vpH = window.innerHeight || document.documentElement.clientHeight;
      var dpr = window.devicePixelRatio || 1;
      var docX = x + scrollLeft;
      var docY = y + scrollTop;

      console.log('[AtlasScreenshot v:' + ATLAS_UI_SELECTION_VERSION + '] capture:', JSON.stringify({
        selection: { x: x, y: y, w: w, h: h },
        scroll: { x: scrollLeft, y: scrollTop },
        docCoords: { x: docX, y: docY },
        vpSize: { w: vpW, h: vpH }, dpr: dpr
      }));

      window.html2canvas(document.body, {
        windowWidth: vpW,
        windowHeight: vpH,
        useCORS: true,
        allowTaint: true,
        logging: false,
      }).then(function (fullCanvas) {
        var bsW = document.body.scrollWidth;
        var bsH = document.body.scrollHeight;
        var scX = fullCanvas.width / bsW;
        var scY = fullCanvas.height / bsH;
        var srcX = Math.round(docX * scX);
        var srcY = Math.round(docY * scY);
        var srcW = Math.round(w * scX);
        var srcH = Math.round(h * scY);

        console.log('[AtlasScreenshot] default canvas:', fullCanvas.width + 'x' + fullCanvas.height,
          'bodyScroll:', bsW + 'x' + bsH, 'scale:', scX.toFixed(2) + '/' + scY.toFixed(2),
          'src:', srcX, srcY, srcW, srcH);

        var out = document.createElement('canvas');
        out.width = w; out.height = h;
        var ctx = out.getContext('2d');
        ctx.drawImage(fullCanvas, srcX, srcY, srcW, srcH, 0, 0, w, h);
        var dataUrl = out.toDataURL('image/png');
        stopScreenshotMode();
        window.parent.postMessage({
          type: 'atlas-screenshot-captured',
          dataUrl: dataUrl, width: w, height: h, x: x, y: y,
        }, '*');
      }).catch(function (err1) {
        // Fallback: foreignObject renderer for pages where the default path misses
        // content. Keep this second because it can distort colors in Chromium.
        console.warn('[AtlasScreenshot] default renderer failed:', err1, '- trying foreignObject');
        window.html2canvas(document.body, {
          windowWidth: vpW, windowHeight: vpH,
          foreignObjectRendering: true,
          useCORS: true, allowTaint: true, logging: false,
        }).then(function (fullCanvas) {
          var bsW = document.body.scrollWidth;
          var bsH = document.body.scrollHeight;
          var scX = fullCanvas.width / bsW;
          var scY = fullCanvas.height / bsH;
          var srcX = Math.round(docX * scX);
          var srcY = Math.round(docY * scY);
          var srcW = Math.round(w * scX);
          var srcH = Math.round(h * scY);

          console.log('[AtlasScreenshot] foreignObject canvas:', fullCanvas.width + 'x' + fullCanvas.height,
            'scale:', scX.toFixed(2) + '/' + scY.toFixed(2));

          var out = document.createElement('canvas');
          out.width = w; out.height = h;
          var ctx = out.getContext('2d');
          ctx.drawImage(fullCanvas, srcX, srcY, srcW, srcH, 0, 0, w, h);
          var dataUrl = out.toDataURL('image/png');
          stopScreenshotMode();
          window.parent.postMessage({
            type: 'atlas-screenshot-captured',
            dataUrl: dataUrl, width: w, height: h, x: x, y: y,
          }, '*');
        }).catch(function (err2) {
          console.error('[AtlasScreenshot] capture failed:', err2);
          stopScreenshotMode();
          window.parent.postMessage({ type: 'atlas-screenshot-error', error: 'Screenshot capture failed' }, '*');
        });
      });
    });
  }

  // Register captureRegion globally so old mouseup handlers (from cached scripts)
  // use the latest version of the function
  window.__atlasCaptureRegion = captureRegion;

  // ── Message handler ──────────────────────────────────────────────
  window.addEventListener('message', function (event) {
    var data = event && event.data ? event.data : null;
    if (!data || !data.type) return;
    if (data.type === 'atlas-ui-select-toggle') {
      setEnabled(data.enabled);
    }
    if (data.type === 'atlas-ui-select-clear') {
      hideHighlight();
    }
    if (data.type === 'atlas-ui-edit') {
      applyEdits(data.payload || {});
    }
    if (data.type === 'atlas-ui-edit-reset') {
      resetEdits();
    }
    if (data.type === 'atlas-screenshot-start') {
      startScreenshotMode();
    }
    if (data.type === 'atlas-screenshot-cancel') {
      stopScreenshotMode();
    }
    if (data.type === 'atlas-ui-version-request') {
      window.parent.postMessage({
        type: 'atlas-ui-select-ready',
        version: ATLAS_UI_SELECTION_VERSION,
      }, '*');
    }
  });

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  window.parent.postMessage({
    type: 'atlas-ui-select-ready',
    version: ATLAS_UI_SELECTION_VERSION,
  }, '*');
  loadPersistedEdits();
})();
