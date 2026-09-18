import { html, render } from '../vendor/preact-htm.mjs';
import { createLocale, LocaleProvider, useLocale, useRoute } from './context.mjs';
import { pickLanguage } from './i18n.mjs';
import { AnimationView } from './components/AnimationView.mjs';
import { ExportView } from './components/ExportView.mjs';
import { LogView } from './components/LogView.mjs';
import { PassageView } from './components/PassageView.mjs';
import { ReplayView } from './components/ReplayView.mjs';
import { StatusBar } from './components/StatusBar.mjs';

function Page({ route }) {
  if (route.name === 'passage') {
    return html`<${PassageView} id=${route.id} />`;
  }
  if (route.name === 'export') {
    return html`<${ExportView} />`;
  }
  if (route.name === 'animation') {
    // Keyed on the range, so arriving from a passage page with dates in the
    // hash starts on those dates rather than keeping the previous ones.
    return html`<${AnimationView} key=${`${route.from}/${route.to}`} from=${route.from} to=${route.to} />`;
  }
  return route.name === 'replay' ? html`<${ReplayView} />` : html`<${LogView} />`;
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
        <a href="#/" aria-current=${current('log')}>${t('nav.log')}</a>
        <a href="#/animation" aria-current=${current('animation')}>${t('nav.animation')}</a>
        <a href="#/export" aria-current=${current('export')}>${t('nav.export')}</a>
        <a href="#/replay" aria-current=${current('replay')}>${t('nav.replay')}</a>
        <a href="entry/">${t('nav.entry')}</a>
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
