import { createContext, useContext, useEffect, useState } from '../vendor/preact-htm.mjs';
import { createFormatter } from './format.mjs';
import { createTranslator } from './i18n.mjs';

const LocaleContext = createContext(null);

export const LocaleProvider = LocaleContext.Provider;

export function createLocale(language) {
  const t = createTranslator(language);
  const format = createFormatter({
    locale: language,
    units: { knots: t('unit.knots'), nauticalMiles: t('unit.nauticalMiles') }
  });
  return { language, t, format };
}

export function useLocale() {
  return useContext(LocaleContext);
}

function parseRoute(hash) {
  const passage = hash.match(/^#\/passages\/(\d+)$/);
  if (passage) {
    return { name: 'passage', id: Number(passage[1]) };
  }
  if (hash === '#/export') {
    return { name: 'export' };
  }
  // The dates a passage page hands over travel in the hash; the playback state
  // does not, since every hash change scrolls the page back to the top.
  const animation = hash.match(/^#\/animation(?:\?(.*))?$/);
  if (animation) {
    const params = new URLSearchParams(animation[1] ?? '');
    return { name: 'animation', from: params.get('from') ?? '', to: params.get('to') ?? '' };
  }
  return hash === '#/replay' ? { name: 'replay' } : { name: 'log' };
}

export function useRoute() {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const onChange = () => {
      setRoute(parseRoute(location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

// Runs `load` now and every `intervalMs`, ignoring results that arrive after
// the component is gone.
export function usePolling(load, intervalMs, dependencies = []) {
  useEffect(() => {
    let active = true;
    const run = () => load(() => active);
    run();
    const timer = intervalMs ? setInterval(run, intervalMs) : null;
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, dependencies);
}
