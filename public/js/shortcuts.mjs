// Keyboard shortcuts of the webapp. Pure, so tests run them under Node with
// plain objects standing in for events.

// A field where the arrow keys with Alt belong to the text being typed; a range
// slider or a checkbox has no use for them.
const NON_TEXT_INPUTS = new Set(['range', 'checkbox', 'radio', 'button', 'submit']);

function isTypingTarget(target) {
  if (!target) {
    return false;
  }
  if (target.isContentEditable || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') {
    return true;
  }
  return target.tagName === 'INPUT' && !NON_TEXT_INPUTS.has(target.type);
}

// Alt+← and Alt+→ step to the previous and the next passage. Any other modifier
// makes it a different shortcut, and none is taken from a text field.
export function stepDirection(event) {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return null;
  }
  if (isTypingTarget(event.target)) {
    return null;
  }
  if (event.key === 'ArrowLeft') {
    return 'previous';
  }
  return event.key === 'ArrowRight' ? 'next' : null;
}
