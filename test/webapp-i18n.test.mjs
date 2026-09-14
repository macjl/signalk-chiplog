import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTranslator, LANGUAGES, MESSAGES, pickLanguage } from '../public/js/i18n.mjs';

const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

describe('webapp translations', () => {
  it('cover the same keys in every language', () => {
    const englishKeys = Object.keys(MESSAGES.en).sort();
    for (const language of LANGUAGES) {
      assert.deepEqual(Object.keys(MESSAGES[language]).sort(), englishKeys, language);
    }
  });

  it('use the same placeholders in every language', () => {
    for (const language of LANGUAGES) {
      for (const [key, text] of Object.entries(MESSAGES.en)) {
        assert.deepEqual(
          placeholders(MESSAGES[language][key]),
          placeholders(text),
          `${language} ${key}`
        );
      }
    }
  });

  it('pick the language from ?lang=, then the browser, then English', () => {
    assert.equal(pickLanguage(['en-GB'], '?lang=fr'), 'fr');
    assert.equal(pickLanguage(['fr-FR', 'en'], ''), 'fr');
    assert.equal(pickLanguage(['de-DE', 'en-US'], ''), 'en');
    assert.equal(pickLanguage(['de-DE'], '?lang=xx'), 'en');
  });

  it('fill placeholders and leave unknown ones visible', () => {
    const t = createTranslator('fr');
    assert.equal(t('passage.stoppedSince', { time: '14:05' }), 'À l’arrêt depuis 14:05');
    assert.equal(t('passage.stoppedSince'), 'À l’arrêt depuis {time}');
  });
});

describe('PDF logbook languages', () => {
  it('are the webapp languages', async () => {
    const { PDF_LANGUAGES } = await import('../lib/logbook-pdf.js');
    assert.deepEqual(PDF_LANGUAGES, LANGUAGES);
  });
});
