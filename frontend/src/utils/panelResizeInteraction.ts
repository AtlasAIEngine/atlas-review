type ResizeStartEvent = {
  preventDefault?: () => void;
  stopPropagation?: () => void;
};

const PANEL_RESIZE_ACTIVE_CLASS = 'atlas-panel-resize-active';

function setIframePointerEvents(value: '' | 'none') {
  if (typeof document === 'undefined') return;
  const iframes = document.querySelectorAll('iframe');
  iframes.forEach((iframe) => {
    (iframe as HTMLElement).style.pointerEvents = value;
  });
}

export function beginPanelResizeInteraction(event?: ResizeStartEvent) {
  event?.preventDefault?.();
  event?.stopPropagation?.();
  if (typeof document === 'undefined') return;

  document.documentElement.classList.add(PANEL_RESIZE_ACTIVE_CLASS);
  document.body.style.cursor = 'col-resize';
  window.getSelection()?.removeAllRanges();
  setIframePointerEvents('none');
}

export function endPanelResizeInteraction() {
  if (typeof document === 'undefined') return;

  document.documentElement.classList.remove(PANEL_RESIZE_ACTIVE_CLASS);
  document.body.style.cursor = '';
  window.getSelection()?.removeAllRanges();
  setIframePointerEvents('');
}

