import { html } from '../../vendor/preact-htm.mjs';
import { useLocale } from '../context.mjs';

export function CrewCard({ crew }) {
  const { t } = useLocale();
  if (crew.length === 0) {
    return null;
  }
  return html`
    <section class="card crew-card">
      <h2>${t('passage.crew')}</h2>
      <ul class="crew-list">
        ${crew.map(
          (member) =>
            html`<li key=${member.id}>
              ${member.name}${member.role ? html` <span class="crew-role">${member.role}</span>` : ''}
            </li>`
        )}
      </ul>
    </section>
  `;
}
