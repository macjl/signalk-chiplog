import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { stepDirection } from '../public/js/shortcuts.mjs';

const key = (name, overrides = {}) => ({
  key: name,
  altKey: true,
  target: { tagName: 'BODY' },
  ...overrides
});

describe('passage stepping shortcut', () => {
  it('goes back with Alt+left and forward with Alt+right', () => {
    assert.equal(stepDirection(key('ArrowLeft')), 'previous');
    assert.equal(stepDirection(key('ArrowRight')), 'next');
  });

  it('ignores the arrows without Alt, and other keys with it', () => {
    assert.equal(stepDirection(key('ArrowLeft', { altKey: false })), null);
    assert.equal(stepDirection(key('ArrowUp')), null);
    assert.equal(stepDirection(key('a')), null);
  });

  it('leaves alone a combination that has another modifier', () => {
    for (const modifier of ['ctrlKey', 'metaKey', 'shiftKey']) {
      assert.equal(stepDirection(key('ArrowLeft', { [modifier]: true })), null, modifier);
    }
  });

  it('leaves the arrows to a field being typed in', () => {
    assert.equal(stepDirection(key('ArrowLeft', { target: { tagName: 'TEXTAREA' } })), null);
    assert.equal(stepDirection(key('ArrowLeft', { target: { tagName: 'SELECT' } })), null);
    assert.equal(
      stepDirection(key('ArrowLeft', { target: { tagName: 'INPUT', type: 'text' } })),
      null
    );
    assert.equal(
      stepDirection(key('ArrowLeft', { target: { tagName: 'DIV', isContentEditable: true } })),
      null
    );
  });

  it('works from a slider, a checkbox or a button, which do not use Alt+arrow', () => {
    for (const type of ['range', 'checkbox', 'button']) {
      assert.equal(
        stepDirection(key('ArrowRight', { target: { tagName: 'INPUT', type } })),
        'next',
        type
      );
    }
    assert.equal(stepDirection(key('ArrowRight', { target: { tagName: 'BUTTON' } })), 'next');
  });
});
