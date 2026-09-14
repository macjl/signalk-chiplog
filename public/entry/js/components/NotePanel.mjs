import { html, useState } from '../../../vendor/preact-htm.mjs';
import { useLocale } from '../../../js/context.mjs';

export function NotePanel({ busy, onLog }) {
  const { t } = useLocale();
  const [text, setText] = useState('');

  const submit = async (event) => {
    event.preventDefault();
    const comment = text.trim();
    if (!comment) {
      return;
    }
    if (await onLog({ type: 'text_annotation', comment }, t('entry.note'))) {
      setText('');
    }
  };

  return html`
    <form class="note-form" onSubmit=${submit}>
      <textarea
        value=${text}
        rows="5"
        maxlength="10000"
        placeholder=${t('entry.notePlaceholder')}
        aria-label=${t('entry.note')}
        onInput=${(event) => setText(event.currentTarget.value)}
      ></textarea>
      <button type="submit" class="big-button primary" disabled=${busy || !text.trim()}>
        ${t('entry.send')}
      </button>
    </form>
  `;
}
