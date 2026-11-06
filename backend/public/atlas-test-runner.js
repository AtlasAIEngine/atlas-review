/**
 * Atlas Test Runner Script
 * Injected into preview iframes to execute automated tests
 *
 * Communication Protocol:
 * - Parent -> Iframe: { type: 'atlas-test-run', test: TestCase }
 * - Parent -> Iframe: { type: 'atlas-test-stop' }
 * - Parent -> Iframe: { type: 'atlas-test-validate-selector', selector: string }
 * - Iframe -> Parent: { type: 'atlas-test-step-result', stepIndex, status, actual?, error?, screenshotData? }
 * - Iframe -> Parent: { type: 'atlas-test-complete', result: TestResult }
 * - Iframe -> Parent: { type: 'atlas-test-ready' }
 * - Iframe -> Parent: { type: 'atlas-test-selector-validation', selector, matches, count }
 */

(function () {
  if (window.__atlasTestRunnerInjected) return;
  window.__atlasTestRunnerInjected = true;

  var isRunning = false;
  var shouldStop = false;
  var testStartTime = 0;
  var html2canvasLoaded = false;
  var html2canvasLoading = false;
  var html2canvasCallbacks = [];

  /**
   * Load html2canvas library from CDN
   */
  function loadHtml2Canvas(callback) {
    if (html2canvasLoaded && window.html2canvas) {
      callback(null);
      return;
    }

    if (html2canvasLoading) {
      html2canvasCallbacks.push(callback);
      return;
    }

    html2canvasLoading = true;
    html2canvasCallbacks.push(callback);

    var script = document.createElement('script');
    script.src = '/html2canvas.min.js';
    script.onload = function () {
      html2canvasLoaded = true;
      html2canvasLoading = false;
      var cbs = html2canvasCallbacks;
      html2canvasCallbacks = [];
      cbs.forEach(function (cb) { cb(null); });
    };
    script.onerror = function () {
      html2canvasLoading = false;
      var cbs = html2canvasCallbacks;
      html2canvasCallbacks = [];
      cbs.forEach(function (cb) { cb(new Error('Failed to load html2canvas')); });
    };
    document.head.appendChild(script);
  }

  /**
   * Find an element using multiple selector strategies
   * Tries selectors in order: data-testid, id, aria-label, name, CSS selector
   */
  function findElement(selector, locator) {
    if (!selector && !locator) return null;

    // Try the primary CSS selector first
    if (selector) {
      try {
        var element = document.querySelector(selector);
        if (element) return { element: element, strategy: 'css' };
      } catch (error) {
        // Invalid selector, continue to fallbacks
      }
    }

    // If locator object provided, try alternative strategies
    if (locator) {
      // Try data-testid
      if (locator.dataTestId) {
        var testIdSelectors = [
          '[data-testid="' + escapeAttr(locator.dataTestId) + '"]',
          '[data-test="' + escapeAttr(locator.dataTestId) + '"]',
          '[data-qa="' + escapeAttr(locator.dataTestId) + '"]',
          '[data-cy="' + escapeAttr(locator.dataTestId) + '"]'
        ];
        for (var i = 0; i < testIdSelectors.length; i++) {
          try {
            var el = document.querySelector(testIdSelectors[i]);
            if (el) return { element: el, strategy: 'data-testid' };
          } catch (e) {}
        }
      }

      // Try id
      if (locator.id) {
        var byId = document.getElementById(locator.id);
        if (byId) return { element: byId, strategy: 'id' };
      }

      // Try aria-label
      if (locator.ariaLabel) {
        try {
          var byAria = document.querySelector('[aria-label="' + escapeAttr(locator.ariaLabel) + '"]');
          if (byAria) return { element: byAria, strategy: 'aria-label' };
        } catch (e) {}
      }

      // Try name attribute
      if (locator.name) {
        try {
          var byName = document.querySelector('[name="' + escapeAttr(locator.name) + '"]');
          if (byName) return { element: byName, strategy: 'name' };
        } catch (e) {}
      }

      // Try role
      if (locator.role) {
        try {
          var byRole = document.querySelector('[role="' + escapeAttr(locator.role) + '"]');
          if (byRole) return { element: byRole, strategy: 'role' };
        } catch (e) {}
      }

      // Try nth-path selector
      if (locator.path) {
        try {
          var byPath = document.querySelector(locator.path);
          if (byPath) return { element: byPath, strategy: 'path' };
        } catch (e) {}
      }

      // Try text content match (last resort)
      if (locator.text) {
        var tagName = locator.tagName || '*';
        var elements = document.querySelectorAll(tagName);
        var targetText = locator.text.trim();
        for (var j = 0; j < elements.length && j < 200; j++) {
          var text = elements[j].innerText || elements[j].textContent || '';
          if (text.trim() === targetText) {
            return { element: elements[j], strategy: 'text' };
          }
        }
      }
    }

    return null;
  }

  function escapeAttr(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  /**
   * Execute a click action
   */
  function executeClick(step) {
    var result = findElement(step.selector, step.locator);
    if (!result) {
      return { status: 'fail', error: 'Element not found: ' + step.selector };
    }

    try {
      var element = result.element;

      // Scroll element into view
      element.scrollIntoView({ block: 'center', behavior: 'smooth' });

      // Brief delay for scroll
      return new Promise(function(resolve) {
        setTimeout(function() {
          try {
            // Use dispatchEvent instead of .click() to support SVG elements
            var clickEvent = new MouseEvent('click', {
              bubbles: true,
              cancelable: true,
              view: window
            });
            element.dispatchEvent(clickEvent);
            resolve({ status: 'pass', actual: 'Clicked element using ' + result.strategy + ' strategy' });
          } catch (clickError) {
            resolve({ status: 'fail', error: 'Click failed: ' + clickError.message });
          }
        }, 100);
      });
    } catch (error) {
      return { status: 'fail', error: 'Click failed: ' + error.message };
    }
  }

  /**
   * Execute a type action
   */
  function executeType(step) {
    var result = findElement(step.selector, step.locator);
    if (!result) {
      return { status: 'fail', error: 'Element not found: ' + step.selector };
    }

    try {
      var element = result.element;

      // Scroll element into view
      element.scrollIntoView({ block: 'center', behavior: 'smooth' });

      return new Promise(function(resolve) {
        setTimeout(function() {
          try {
            // Focus the element
            element.focus();

            // Clear existing value
            if ('value' in element) {
              element.value = '';
            }

            // Set the new value
            var value = step.value || '';
            if ('value' in element) {
              element.value = value;
            } else if (element.isContentEditable) {
              element.textContent = value;
            }

            // Dispatch input events to trigger any listeners
            var inputEvent = new Event('input', { bubbles: true, cancelable: true });
            element.dispatchEvent(inputEvent);

            var changeEvent = new Event('change', { bubbles: true, cancelable: true });
            element.dispatchEvent(changeEvent);

            resolve({ status: 'pass', actual: 'Typed "' + value + '" using ' + result.strategy + ' strategy' });
          } catch (typeError) {
            resolve({ status: 'fail', error: 'Type failed: ' + typeError.message });
          }
        }, 100);
      });
    } catch (error) {
      return { status: 'fail', error: 'Type failed: ' + error.message };
    }
  }

  /**
   * Execute a navigate action
   */
  function executeNavigate(step) {
    return new Promise(function(resolve) {
      try {
        var url = step.value;
        if (!url) {
          resolve({ status: 'fail', error: 'URL is required for navigate action' });
          return;
        }

        // Handle relative URLs
        if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('/')) {
          url = '/' + url;
        }

        window.location.href = url;

        // The page will navigate away, but we report success
        // The test will continue after navigation if there are more steps
        resolve({ status: 'pass', actual: 'Navigated to ' + url });
      } catch (error) {
        resolve({ status: 'fail', error: 'Navigate failed: ' + error.message });
      }
    });
  }

  /**
   * Execute an assert action
   */
  function executeAssert(step) {
    var result = findElement(step.selector, step.locator);
    if (!result) {
      return { status: 'fail', error: 'Element not found: ' + step.selector };
    }

    try {
      var element = result.element;
      var expected = step.expected || '';

      // Get the actual value/text
      var actual = '';
      if ('value' in element && element.value) {
        actual = element.value;
      } else {
        actual = element.innerText || element.textContent || '';
      }
      actual = actual.trim();

      // Compare
      if (actual.includes(expected)) {
        return { status: 'pass', actual: actual };
      } else {
        return {
          status: 'fail',
          actual: actual,
          error: 'Expected "' + expected + '" but got "' + actual + '"'
        };
      }
    } catch (error) {
      return { status: 'fail', error: 'Assert failed: ' + error.message };
    }
  }

  /**
   * Find visible modal/overlay element if one exists
   * Returns the modal CONTENT element (not the backdrop), or null if no modal is visible
   */
  function isVisibleElement(el, style, rect) {
    if (!el || !style || !rect) return false;
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (parseFloat(style.opacity) <= 0) return false;
    if (rect.width <= 0 || rect.height <= 0) return false;
    return true;
  }

  function isBackdropElement(el, style, rect) {
    if (!isVisibleElement(el, style, rect)) return false;
    if (style.position !== 'fixed' && style.position !== 'absolute') return false;

    var viewportWidth = window.innerWidth;
    var viewportHeight = window.innerHeight;
    var areaRatio = (rect.width * rect.height) / (viewportWidth * viewportHeight);
    if (areaRatio < 0.9) return false;

    var bgColor = style.backgroundColor || '';
    var opacity = parseFloat(style.opacity || '1');
    var hasTransparentBg = bgColor === 'transparent' || bgColor === 'rgba(0, 0, 0, 0)';
    var isRgba = bgColor.indexOf('rgba') !== -1;
    var isSemiTransparent = isRgba && bgColor.indexOf('0.') !== -1;
    var hasBackdropFilter = (style.backdropFilter && style.backdropFilter !== 'none') ||
      (style.webkitBackdropFilter && style.webkitBackdropFilter !== 'none');

    return opacity < 0.98 || hasTransparentBg || isSemiTransparent || hasBackdropFilter;
  }

  function hasBackdropInDom() {
    var elements = document.querySelectorAll('body *');
    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      var style = window.getComputedStyle(el);
      var rect = el.getBoundingClientRect();
      if (isBackdropElement(el, style, rect)) {
        return true;
      }
    }
    return false;
  }

  function findModalFromCloseButton() {
    var closeSelectors = [
      'button[aria-label="Close"]',
      'button[aria-label*="close" i]',
      '[aria-label="Close"]',
      '[aria-label*="close" i]',
      'button[title*="close" i]',
      '[data-close]',
      '.modal-close',
      '.dialog-close',
      '.close-button',
      '.close'
    ];

    for (var i = 0; i < closeSelectors.length; i++) {
      var selector = closeSelectors[i];
      try {
        var buttons = document.querySelectorAll(selector);
        for (var j = 0; j < buttons.length; j++) {
          var node = buttons[j];
          while (node && node !== document.body) {
            var rect = node.getBoundingClientRect();
            var style = window.getComputedStyle(node);
            if (isVisibleElement(node, style, rect)) {
              var areaRatio = (rect.width * rect.height) / (window.innerWidth * window.innerHeight);
              var zIndex = parseInt(style.zIndex, 10);
              var isPositioned = style.position === 'fixed' ||
                style.position === 'absolute' ||
                style.position === 'sticky';
              if (rect.width > 50 && rect.height > 50 &&
                  areaRatio > 0.08 && areaRatio < 0.98 &&
                  (isPositioned || (!isNaN(zIndex) && zIndex > 10))) {
                console.log('[atlas-test] Found modal from close button');
                return node;
              }
            }
            node = node.parentElement;
          }
        }
      } catch (e) {
        // Selector might be invalid, continue
      }
    }

    return null;
  }

  function findBestModalCandidate() {
    var elements = document.querySelectorAll('body *');
    var viewportArea = window.innerWidth * window.innerHeight;
    var best = null;
    var bestScore = -Infinity;

    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      if (el === document.body || el === document.documentElement) continue;
      var style = window.getComputedStyle(el);
      var rect = el.getBoundingClientRect();
      if (!isVisibleElement(el, style, rect)) continue;
      if (rect.width < 50 || rect.height < 50) continue;
      if (rect.bottom < 0 || rect.right < 0 || rect.top > window.innerHeight || rect.left > window.innerWidth) {
        continue;
      }
      if (isBackdropElement(el, style, rect)) continue;

      var areaRatio = (rect.width * rect.height) / viewportArea;
      if (areaRatio < 0.05 || areaRatio > 0.98) continue;

      var position = style.position;
      var zIndex = parseInt(style.zIndex, 10);
      var hasPosition = position === 'fixed' || position === 'absolute' || position === 'sticky';
      var hasZIndex = !isNaN(zIndex) && zIndex >= 10;
      if (!hasPosition && !hasZIndex) continue;
      var zScore = isNaN(zIndex) ? 0 : Math.min(zIndex, 10000) / 1000;
      var positionScore = hasPosition ? 5 : 0;

      var centerX = rect.left + rect.width / 2;
      var centerY = rect.top + rect.height / 2;
      var centerDist = Math.abs(centerX - window.innerWidth / 2) + Math.abs(centerY - window.innerHeight / 2);
      var centerScore = Math.max(0, 10 - (centerDist / (window.innerWidth + window.innerHeight)) * 20);

      var score = (areaRatio * 100) + zScore + positionScore + centerScore;
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }

    if (best) {
      console.log('[atlas-test] Found modal via heuristic candidate');
    }
    return best;
  }

  function findVisibleModal() {
    // First, check specifically for .modal-overlay -> .modal-container pattern
    // This is the most common pattern and we want to capture the CONTAINER, not the overlay
    var overlay = document.querySelector('.modal-overlay:not([style*="display: none"])');
    if (overlay) {
      var style = window.getComputedStyle(overlay);
      if (style.display !== 'none' && style.visibility !== 'hidden') {
        // Found visible overlay - look for container inside
        var container = overlay.querySelector('.modal-container');
        if (container) {
          var containerRect = container.getBoundingClientRect();
          if (containerRect.width > 50 && containerRect.height > 50) {
            console.log('[atlas-test] Found modal-container inside modal-overlay');
            return container;
          }
        }
      }
    }

    // Also check for .modal-container directly (might not be nested in overlay)
    var directContainer = document.querySelector('.modal-container:not([style*="display: none"])');
    if (directContainer) {
      var directStyle = window.getComputedStyle(directContainer);
      var directRect = directContainer.getBoundingClientRect();
      if (directStyle.display !== 'none' &&
          directStyle.visibility !== 'hidden' &&
          directRect.width > 50 && directRect.height > 50) {
        console.log('[atlas-test] Found direct modal-container');
        return directContainer;
      }
    }

    // Common modal selectors - check for visible modals
    // Order matters: content containers come before overlays/backdrops
    var modalSelectors = [
      '[data-radix-dialog-content]',
      '[data-reach-dialog-content]',
      '[data-headlessui-state="open"][role="dialog"]',
      '[data-state="open"][role="dialog"]',
      '[data-dialog-content]',
      '[data-modal-content]',
      '.MuiDialog-paper',
      '.MuiModal-root .MuiPaper-root',
      '[role="dialog"]',
      '[aria-modal="true"]',
      '.modal-content:not([style*="display: none"])',
      '.dialog-content:not([style*="display: none"])',
      '.popup-content:not([style*="display: none"])',
      '.modal:not([style*="display: none"])',
      '.dialog:not([style*="display: none"])',
      '.popup:not([style*="display: none"])'
    ];

    for (var i = 0; i < modalSelectors.length; i++) {
      try {
        var elements = document.querySelectorAll(modalSelectors[i]);
        for (var j = 0; j < elements.length; j++) {
          var el = elements[j];
          var elStyle = window.getComputedStyle(el);
          var rect = el.getBoundingClientRect();

          // Check if element is visible
          if (elStyle.display !== 'none' &&
              elStyle.visibility !== 'hidden' &&
              parseFloat(elStyle.opacity) > 0 &&
              rect.width > 50 &&
              rect.height > 50) {

            // Skip if this is just a backdrop/overlay (semi-transparent background, full viewport)
            var isBackdrop = isBackdropElement(el, elStyle, rect);

            if (isBackdrop) {
              // This looks like a backdrop - find the actual content inside
              var innerContent = el.querySelector('.modal-container, .modal-content, .dialog-content, .popup-content');
              if (innerContent) {
                var innerRect = innerContent.getBoundingClientRect();
                if (innerRect.width > 50 && innerRect.height > 50) {
                  console.log('[atlas-test] Found content inside backdrop');
                  return innerContent;
                }
              }
              continue; // Skip this backdrop, look for other modals
            }

            // Check if it's positioned fixed/absolute (typical for modals)
            if (elStyle.position === 'fixed' || elStyle.position === 'absolute') {
              console.log('[atlas-test] Found modal element: ' + el.className);
              return el;
            }
          }
        }
      } catch (e) {
        // Selector might be invalid, continue
      }
    }

    var closeButtonModal = findModalFromCloseButton();
    if (closeButtonModal) {
      return closeButtonModal;
    }

    var backdropPresent = hasBackdropInDom();
    if (backdropPresent) {
      var heuristicModal = findBestModalCandidate();
      if (heuristicModal) {
        return heuristicModal;
      }
    }

    if (backdropPresent) {
      // Last resort: check for elements with high z-index that cover the viewport
      var allElements = document.querySelectorAll('*');
      for (var k = 0; k < allElements.length; k++) {
        var elem = allElements[k];
        var computedStyle = window.getComputedStyle(elem);
        var zIndex = parseInt(computedStyle.zIndex, 10);

        if (zIndex > 100 && computedStyle.position === 'fixed') {
          var bounds = elem.getBoundingClientRect();
          // Check if it's a large overlay element (likely a backdrop)
          if (bounds.width > window.innerWidth * 0.8 && bounds.height > window.innerHeight * 0.8) {
            // This is probably a backdrop - find nested content container first
            var content = elem.querySelector('.modal-container, .modal-content, .dialog-content, .popup-content');
            if (content) {
              var contentBounds = content.getBoundingClientRect();
              if (contentBounds.width > 50 && contentBounds.height > 50) {
                console.log('[atlas-test] Found content in high-z-index backdrop');
                return content;
              }
            }
            // Only return the element if it is not a backdrop
            if (!isBackdropElement(elem, computedStyle, bounds)) {
              return elem;
            }
          }
        }
      }
    }

    return null;
  }

  /**
   * Execute a screenshot action
   */
  function executeScreenshot(step) {
    return new Promise(function (resolve) {
      loadHtml2Canvas(function (loadError) {
        if (loadError) {
          resolve({ status: 'fail', error: 'Failed to load html2canvas: ' + loadError.message });
          return;
        }

        // Longer delay to ensure modals/popups and animations have rendered
        setTimeout(function () {
          // Always capture the full page (including any visible modals)
          var targetElement = document.documentElement;
          var captureOptions = {
            useCORS: true,
            allowTaint: true,
            logging: false,
            scale: 1,
            width: document.documentElement.scrollWidth,
            height: document.documentElement.scrollHeight,
            windowWidth: window.innerWidth,
            windowHeight: window.innerHeight,
            x: 0,
            y: 0,
            scrollX: 0,
            scrollY: 0,
            foreignObjectRendering: false,
            removeContainer: true
          };

          function finalizeCanvas(canvas) {
            try {
              var imageData = canvas.toDataURL('image/png');
              var screenshotName = step.screenshotName || 'screenshot';
              resolve({
                status: 'pass',
                actual: 'Captured screenshot: ' + screenshotName,
                screenshotData: {
                  imageData: imageData,
                  name: screenshotName,
                  threshold: step.threshold !== undefined ? step.threshold : 0.1
                }
              });
            } catch (canvasError) {
              resolve({ status: 'fail', error: 'Failed to convert canvas to image: ' + canvasError.message });
            }
          }

          window.html2canvas(targetElement, Object.assign({}, captureOptions, {
            foreignObjectRendering: false
          })).then(function (canvas) {
            finalizeCanvas(canvas);
          }).catch(function () {
            window.html2canvas(targetElement, Object.assign({}, captureOptions, {
              foreignObjectRendering: true
            })).then(function (canvas) {
              finalizeCanvas(canvas);
            }).catch(function (error) {
              resolve({ status: 'fail', error: 'Screenshot capture failed: ' + error.message });
            });
          });
        }, 200);
      });
    });
  }

  /**
   * Execute a single step
   */
  async function executeStep(step, stepIndex) {
    var result;

    switch (step.action) {
      case 'click':
        result = await executeClick(step);
        break;
      case 'type':
        result = await executeType(step);
        break;
      case 'navigate':
        result = await executeNavigate(step);
        break;
      case 'assert':
        result = executeAssert(step);
        break;
      case 'screenshot':
        result = await executeScreenshot(step);
        break;
      default:
        result = { status: 'fail', error: 'Unknown action: ' + step.action };
    }

    return {
      stepIndex: stepIndex,
      status: result.status,
      actual: result.actual,
      error: result.error,
      screenshotData: result.screenshotData
    };
  }

  /**
   * Run a complete test
   */
  async function runTest(test) {
    if (isRunning) {
      console.warn('[AtlasTest] Test already running');
      return;
    }

    isRunning = true;
    shouldStop = false;
    testStartTime = Date.now();

    var steps = test.steps || [];
    var stepResults = [];
    var overallStatus = 'pass';

    for (var i = 0; i < steps.length; i++) {
      if (shouldStop) {
        // Mark remaining steps as skipped
        for (var j = i; j < steps.length; j++) {
          stepResults.push({
            stepIndex: j,
            status: 'skipped',
            error: 'Test stopped by user'
          });
        }
        overallStatus = 'fail';
        break;
      }

      var step = steps[i];
      var stepResult = await executeStep(step, i);
      stepResults.push(stepResult);

      // Report step result
      window.parent.postMessage({
        type: 'atlas-test-step-result',
        stepIndex: stepResult.stepIndex,
        status: stepResult.status,
        actual: stepResult.actual,
        error: stepResult.error,
        screenshotData: stepResult.screenshotData
      }, '*');

      if (stepResult.status === 'fail') {
        overallStatus = 'fail';
        // Continue or stop based on config (for now, continue)
      }

      // Small delay between steps for stability
      await new Promise(function(resolve) { setTimeout(resolve, 200); });
    }

    var duration = Date.now() - testStartTime;
    isRunning = false;

    // Report completion
    window.parent.postMessage({
      type: 'atlas-test-complete',
      result: {
        testId: test.id,
        status: overallStatus,
        steps: stepResults,
        duration: duration,
        timestamp: new Date().toISOString()
      }
    }, '*');
  }

  /**
   * Stop the current test
   */
  function stopTest() {
    shouldStop = true;
  }

  /**
   * Validate a selector and count matches
   */
  function validateSelector(selector) {
    try {
      var elements = document.querySelectorAll(selector);
      return {
        selector: selector,
        matches: elements.length > 0,
        count: elements.length
      };
    } catch (error) {
      return {
        selector: selector,
        matches: false,
        count: 0,
        error: error.message
      };
    }
  }

  /**
   * Message handler
   */
  window.addEventListener('message', function(event) {
    var data = event && event.data;
    if (!data || !data.type) return;

    if (data.type === 'atlas-test-run' && data.test) {
      runTest(data.test);
    }

    if (data.type === 'atlas-test-stop') {
      stopTest();
    }

    if (data.type === 'atlas-test-validate-selector' && data.selector) {
      var validation = validateSelector(data.selector);
      window.parent.postMessage({
        type: 'atlas-test-selector-validation',
        selector: validation.selector,
        matches: validation.matches,
        count: validation.count,
        error: validation.error
      }, '*');
    }
  });

  // Notify parent that test runner is ready
  console.log('[AtlasTest] Test runner initialized');
  window.parent.postMessage({ type: 'atlas-test-ready' }, '*');
})();
