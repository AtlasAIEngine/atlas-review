export function isSetupAdvanceKey(event: KeyboardEvent) {
  return event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar' || event.code === 'Space';
}

export function shouldIgnoreSetupShortcut(event: KeyboardEvent) {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) {
    return true;
  }

  const target = event.target as HTMLElement | null;
  if (!target) {
    return false;
  }

  if (target.isContentEditable) {
    return true;
  }

  const tagName = target.tagName.toLowerCase();
  if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') {
    return true;
  }

  return Boolean(
    target.closest('button, a, [role="button"], [role="menuitem"], [role="switch"], [contenteditable="true"]')
  );
}
