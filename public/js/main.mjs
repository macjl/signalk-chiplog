import { html, render } from '../vendor/preact-htm.mjs';
import { createLocale, LocaleProvider, useLocale, useRoute } from './context.mjs';
import { pickLanguage } from './i18n.mjs';
import { ExportView } from './components/ExportView.mjs';
import { LogView } from './components/LogView.mjs';
import { PassageView } from './components/PassageView.mjs';
import { StatusBar } from './components/StatusBar.mjs';

function Page({ route }) {
  if (route.name === 'passage') {
    return html`<${PassageView} id=${route.id} />`;
  }
  return route.name === 'export' ? html`<${ExportView} />` : html`<${LogView} />`;
}

function Shell() {
  const { t } = useLocale();
  const route = useRoute();
  const current = (name) => (route.name === name ? 'page' : undefined);

  return html`
    <header class="topbar">
      <a class="brand" href="#/">
        <img src="icon.svg" alt="" width="28" height="28" />
        ${t('app.title')}
      </a>
      <nav>
        <a href="#/" aria-current=${route.name === 'export' ? undefined : 'page'}
          >${t('nav.log')}</a
        >
        <a href="#/export" aria-current=${current('export')}>${t('nav.export')}</a>
      </nav>
    </header>
    <${StatusBar} />
    <main><${Page} route=${route} /></main>
    <footer class="attribution">${t('footer.attribution')}</footer>
  `;
}

const locale = createLocale(pickLanguage(navigator.languages, location.search));
document.documentElement.lang = locale.language;
document.title = locale.t('app.title');

render(
  html`<${LocaleProvider} value=${locale}><${Shell} /></${LocaleProvider}>`,
  document.getElementById('app')
);
