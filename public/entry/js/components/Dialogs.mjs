import { html, useEffect, useRef, useState } from '../../../vendor/preact-htm.mjs';
import { useLocale } from '../../../js/context.mjs';

export function CommentDialog({ title, initial = '', onSave, onCancel }) {
  const { t } = useLocale();
  const [text, setText] = useState(initial ?? '');
  const field = useRef(null);
  useEffect(() => field.current?.focus(), []);

  const submit = (event) => {
    event.preventDefault();
    onSave(text.trim() === '' ? null : text.trim());
  };

  return html`
    <div class="sheet-backdrop" onClick=${(event) => event.target === event.currentTarget && onCancel()}>
      <form class="sheet" role="dialog" aria-modal="true" aria-labelledby="comment-title" onSubmit=${submit}>
        <h2 id="comment-title">${title}</h2>
        <textarea
          ref=${field}
          rows="4"
          maxlength="10000"
          value=${text}
          aria-label=${t('entry.comment')}
          onInput=${(event) => setText(event.currentTarget.value)}
        ></textarea>
        <div class="sheet-row">
          <button type="button" class="big-button" onClick=${onCancel}>${t('common.cancel')}</button>
          <button type="submit" class="big-button primary">${t('common.save')}</button>
        </div>
      </form>
    </div>
  `;
}

// What was just logged, with the two things one wants right after: undo a
// mistaken tap, or add a word about it.
export function Toast({ toast, onUndo, onComment, onClose }) {
  const { t, format } = useLocale();
  if (!toast) {
    return null;
  }
  if (toast.kind === 'error') {
    return html`
      <div class="toast toast-error" role="alert">
        <span class="toast-text">${toast.message}</span>
        <button type="button" class="tool-button" onClick=${onClose}>×</button>
      </div>
    `;
  }
  if (toast.kind === 'undone') {
    return html`<div class="toast" role="status"><span class="toast-text">${t('entry.undone')}</span></div>`;
  }
  const detail = toast.queued
    ? t('entry.loggedQueued')
    : `${t('entry.logged', { time: format.time(toast.time) })}${toast.openedEntry ? ` · ${t('entry.openedPassage')}` : ''}`;
  return html`
    <div class=${toast.queued ? 'toast toast-queued' : 'toast'} role="status">
      <span class="toast-text"><strong>${toast.what}</strong><br />${detail}</span>
      <button type="button" class="big-button" onClick=${onComment}>${t('entry.addComment')}</button>
      <button type="button" class="big-button" onClick=${onUndo}>${t('entry.undo')}</button>
    </div>
  `;
}
