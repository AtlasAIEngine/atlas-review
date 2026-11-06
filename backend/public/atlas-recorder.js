/**
 * Atlas Test Recorder Script
 * Injected into preview iframes to capture user interactions for test recording
 *
 * Communication Protocol:
 * - Parent -> Iframe: { type: 'atlas-record-start' }
 * - Parent -> Iframe: { type: 'atlas-record-stop' }
 * - Iframe -> Parent: { type: 'atlas-record-action', action, selector, value?, elementInfo, timestamp }
 * - Iframe -> Parent: { type: 'atlas-recorder-ready' }
 */

(function () {
  if (window.__atlasRecorderInjected) return;
  window.__atlasRecorderInjected = true;

  var isRecording = false;

  // Typing debounce state
  var typingTimer = null;
  var currentTypingElement = null;
  var currentTypingValue = '';
  var currentTypingSelector = '';
  var TYPING_DEBOUNCE_MS = 500;

  /**
   * Generate a stable CSS selector for an element
   * Priority order:
   * 1. data-testid, data-test, data-cy
   * 2. id attribute (if unique)
   * 3. name attribute (for form elements)
   * 4. aria-label
   * 5. Unique class + tag combination
   * 6. nth-of-type path (fallback)
   */
  function generateSelector(element) {
    if (!element || element === document.body || element === document.documentElement) {
      return null;
    }

    // 1. Test IDs (highest priority - designed for testing)
    var testIdAttrs = ['data-testid', 'data-test', 'data-cy', 'data-qa'];
    for (var i = 0; i < testIdAttrs.length; i++) {
      var testId = element.getAttribute(testIdAttrs[i]);
      if (testId) {
        var selector = '[' + testIdAttrs[i] + '="' + escapeAttr(testId) + '"]';
        if (isUniqueSelector(selector)) {
          return selector;
        }
      }
    }

    // 2. ID attribute (if truly unique)
    if (element.id && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(element.id)) {
      var idSelector = '#' + element.id;
      if (isUniqueSelector(idSelector)) {
        return idSelector;
      }
    }

    // 3. Name attribute (for form elements)
    var name = element.getAttribute('name');
    if (name) {
      var tagName = element.tagName.toLowerCase();
      var nameSelector = tagName + '[name="' + escapeAttr(name) + '"]';
      if (isUniqueSelector(nameSelector)) {
        return nameSelector;
      }
    }

    // 4. Aria-label
    var ariaLabel = element.getAttribute('aria-label');
    if (ariaLabel) {
      var ariaSelector = '[aria-label="' + escapeAttr(ariaLabel) + '"]';
      if (isUniqueSelector(ariaSelector)) {
        return ariaSelector;
      }
    }

    // 5. Role + text content for buttons/links
    var role = element.getAttribute('role') || getImplicitRole(element);
    var textContent = getDirectText(element);
    if (role && textContent && ['button', 'link', 'menuitem', 'tab'].indexOf(role) !== -1) {
      // Try role-based selector with text
      var roleSelector = '[role="' + role + '"]';
      var matchingByRole = document.querySelectorAll(roleSelector);
      for (var j = 0; j < matchingByRole.length; j++) {
        if (getDirectText(matchingByRole[j]) === textContent && matchingByRole[j] === element) {
          // This element is uniquely identifiable by role + position
          if (matchingByRole.length === 1) {
            return roleSelector;
          }
        }
      }
    }

    // 6. Button/link by text content
    var tagLower = element.tagName.toLowerCase();
    if ((tagLower === 'button' || tagLower === 'a') && textContent) {
      var textSelector = tagLower;
      var matchingByTag = document.querySelectorAll(textSelector);
      var textMatches = [];
      for (var k = 0; k < matchingByTag.length; k++) {
        if (getDirectText(matchingByTag[k]) === textContent) {
          textMatches.push(matchingByTag[k]);
        }
      }
      if (textMatches.length === 1 && textMatches[0] === element) {
        // Unique by tag + text - return a positional selector
        return getNthOfTypeSelector(element);
      }
    }

    // 7. Unique class combination
    var classes = element.className;
    if (typeof classes === 'string' && classes.trim()) {
      var classList = classes.trim().split(/\s+/).filter(function(c) {
        // Filter out dynamic classes (e.g., those with random hashes)
        return c && !/^[a-z]+-[a-f0-9]{5,}$/i.test(c) && c.length < 30;
      });

      if (classList.length > 0) {
        // Try single unique class
        for (var m = 0; m < classList.length; m++) {
          var classSelector = '.' + escapeClass(classList[m]);
          if (isUniqueSelector(classSelector)) {
            return classSelector;
          }
        }

        // Try tag + class combination
        var tagClassSelector = tagLower + '.' + classList.map(escapeClass).join('.');
        if (isUniqueSelector(tagClassSelector)) {
          return tagClassSelector;
        }
      }
    }

    // 8. Fallback: nth-of-type path
    return getNthOfTypeSelector(element);
  }

  /**
   * Get nth-of-type selector path from element to a unique ancestor
   */
  function getNthOfTypeSelector(element) {
    var path = [];
    var current = element;

    while (current && current !== document.body && current !== document.documentElement) {
      var tag = current.tagName.toLowerCase();
      var parent = current.parentElement;

      if (!parent) break;

      // Find position among same-tag siblings
      var siblings = parent.querySelectorAll(':scope > ' + tag);
      var index = 1;
      for (var i = 0; i < siblings.length; i++) {
        if (siblings[i] === current) {
          index = i + 1;
          break;
        }
      }

      var part = tag;
      if (siblings.length > 1) {
        part = tag + ':nth-of-type(' + index + ')';
      }

      path.unshift(part);

      // Check if current path is unique
      var currentPath = path.join(' > ');
      if (isUniqueSelector(currentPath)) {
        return currentPath;
      }

      // Add ID if available to make path shorter
      if (current.id && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(current.id)) {
        path = ['#' + current.id].concat(path.slice(1));
        var idPath = path.join(' > ');
        if (isUniqueSelector(idPath)) {
          return idPath;
        }
      }

      current = parent;
    }

    return path.join(' > ') || 'body';
  }

  /**
   * Check if a selector uniquely identifies one element
   */
  function isUniqueSelector(selector) {
    try {
      var matches = document.querySelectorAll(selector);
      return matches.length === 1;
    } catch (e) {
      return false;
    }
  }

  /**
   * Get the implicit ARIA role for an element
   */
  function getImplicitRole(element) {
    var tag = element.tagName.toLowerCase();
    var type = element.getAttribute('type');

    if (tag === 'button') return 'button';
    if (tag === 'a' && element.hasAttribute('href')) return 'link';
    if (tag === 'input') {
      if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      return 'textbox';
    }
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';

    return null;
  }

  /**
   * Get direct text content (not from children)
   */
  function getDirectText(element) {
    var text = '';
    for (var i = 0; i < element.childNodes.length; i++) {
      if (element.childNodes[i].nodeType === Node.TEXT_NODE) {
        text += element.childNodes[i].textContent;
      }
    }
    return text.trim().substring(0, 50);
  }

  /**
   * Escape attribute value for use in selector
   */
  function escapeAttr(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  /**
   * Escape class name for use in selector
   */
  function escapeClass(className) {
    return className.replace(/([!"#$%&'()*+,.\/:;<=>?@[\\\]^`{|}~])/g, '\\$1');
  }

  /**
   * Get element info for display
   */
  function getElementInfo(element) {
    return {
      tagName: element.tagName.toLowerCase(),
      text: getDirectText(element) || (element.innerText || '').substring(0, 50),
      type: element.getAttribute('type') || undefined,
      placeholder: element.getAttribute('placeholder') || undefined,
      name: element.getAttribute('name') || undefined,
      id: element.id || undefined,
      role: element.getAttribute('role') || getImplicitRole(element) || undefined
    };
  }

  /**
   * Send recorded action to parent
   */
  function sendRecordedAction(action, selector, value, elementInfo) {
    window.parent.postMessage({
      type: 'atlas-record-action',
      action: action,
      selector: selector,
      value: value,
      elementInfo: elementInfo,
      timestamp: Date.now()
    }, '*');
  }

  /**
   * Flush pending typing action
   */
  function flushTypingAction() {
    if (currentTypingElement && currentTypingValue !== '') {
      var elementInfo = getElementInfo(currentTypingElement);
      sendRecordedAction('type', currentTypingSelector, currentTypingValue, elementInfo);
    }

    clearTimeout(typingTimer);
    typingTimer = null;
    currentTypingElement = null;
    currentTypingValue = '';
    currentTypingSelector = '';
  }

  /**
   * Handle click events
   */
  function handleClick(event) {
    if (!isRecording) return;

    var target = event.target;

    // Ignore clicks on non-interactive elements that are likely just containers
    var tag = target.tagName.toLowerCase();
    var isInteractive = ['a', 'button', 'input', 'select', 'textarea', 'label'].indexOf(tag) !== -1;
    var hasOnClick = target.onclick !== null;
    var hasRole = target.hasAttribute('role');
    var isClickable = target.style.cursor === 'pointer' || window.getComputedStyle(target).cursor === 'pointer';

    // Allow clicks on interactive elements or elements that look clickable
    if (!isInteractive && !hasOnClick && !hasRole && !isClickable) {
      // Check if any parent is a button or link
      var parent = target.parentElement;
      var maxDepth = 3;
      while (parent && maxDepth > 0) {
        var parentTag = parent.tagName.toLowerCase();
        if (parentTag === 'button' || parentTag === 'a' || parent.getAttribute('role') === 'button') {
          target = parent;
          isInteractive = true;
          break;
        }
        parent = parent.parentElement;
        maxDepth--;
      }

      if (!isInteractive) {
        return; // Ignore this click
      }
    }

    // Flush any pending typing before recording click
    if (currentTypingElement) {
      flushTypingAction();
    }

    // Don't record clicks on inputs that are about to receive typing
    if (tag === 'input' || tag === 'textarea') {
      // Will be handled by typing events
      return;
    }

    var selector = generateSelector(target);
    if (!selector) return;

    var elementInfo = getElementInfo(target);
    sendRecordedAction('click', selector, null, elementInfo);
  }

  /**
   * Handle input events (typing)
   */
  function handleInput(event) {
    if (!isRecording) return;

    var target = event.target;
    var tag = target.tagName.toLowerCase();

    // Only track input/textarea elements
    if (tag !== 'input' && tag !== 'textarea') return;

    // Skip password fields for security
    if (target.type === 'password') return;

    var selector = generateSelector(target);
    if (!selector) return;

    // If typing in a new element, flush previous
    if (currentTypingElement && currentTypingElement !== target) {
      flushTypingAction();
    }

    currentTypingElement = target;
    currentTypingValue = target.value || '';
    currentTypingSelector = selector;

    // Reset debounce timer
    clearTimeout(typingTimer);
    typingTimer = setTimeout(function() {
      flushTypingAction();
    }, TYPING_DEBOUNCE_MS);
  }

  /**
   * Handle change events (for selects and other controls)
   */
  function handleChange(event) {
    if (!isRecording) return;

    var target = event.target;
    var tag = target.tagName.toLowerCase();

    // Handle select elements
    if (tag === 'select') {
      var selector = generateSelector(target);
      if (!selector) return;

      var elementInfo = getElementInfo(target);
      var selectedText = target.options[target.selectedIndex]?.text || target.value;
      sendRecordedAction('type', selector, target.value, elementInfo);
    }
  }

  /**
   * Handle beforeunload for navigation detection
   */
  function handleBeforeUnload(event) {
    if (!isRecording) return;

    // Flush any pending typing
    if (currentTypingElement) {
      flushTypingAction();
    }
  }

  /**
   * Handle popstate for SPA navigation
   */
  function handlePopState(event) {
    if (!isRecording) return;

    // Record navigation
    sendRecordedAction('navigate', null, window.location.pathname + window.location.search, {
      tagName: 'navigation',
      text: 'Browser navigation'
    });
  }

  /**
   * Start recording
   */
  function startRecording() {
    if (isRecording) return;

    isRecording = true;
    console.log('[AtlasRecorder] Recording started');

    // Add event listeners
    document.addEventListener('click', handleClick, true);
    document.addEventListener('input', handleInput, true);
    document.addEventListener('change', handleChange, true);
    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener('popstate', handlePopState);

    // Notify parent
    window.parent.postMessage({ type: 'atlas-recorder-started' }, '*');
  }

  /**
   * Stop recording
   */
  function stopRecording() {
    if (!isRecording) return;

    // Flush any pending typing
    if (currentTypingElement) {
      flushTypingAction();
    }

    isRecording = false;
    console.log('[AtlasRecorder] Recording stopped');

    // Remove event listeners
    document.removeEventListener('click', handleClick, true);
    document.removeEventListener('input', handleInput, true);
    document.removeEventListener('change', handleChange, true);
    window.removeEventListener('beforeunload', handleBeforeUnload);
    window.removeEventListener('popstate', handlePopState);

    // Notify parent
    window.parent.postMessage({ type: 'atlas-recorder-stopped' }, '*');
  }

  /**
   * Message handler
   */
  window.addEventListener('message', function(event) {
    var data = event && event.data;
    if (!data || !data.type) return;

    if (data.type === 'atlas-record-start') {
      startRecording();
    }

    if (data.type === 'atlas-record-stop') {
      stopRecording();
    }
  });

  // Notify parent that recorder is ready
  console.log('[AtlasRecorder] Recorder initialized');
  window.parent.postMessage({ type: 'atlas-recorder-ready' }, '*');
})();
