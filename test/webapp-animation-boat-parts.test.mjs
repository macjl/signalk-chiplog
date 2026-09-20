import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findSails, SAIL_ROLES, sailRole } from '../public/js/animation/boat-parts.mjs';

describe('recognising the sails of a crew’s model', () => {
  it('finds the mainsail and the headsail by name, in English or French', () => {
    for (const name of [
      'Mainsail',
      'main_sail',
      'Sail_Main',
      'Main',
      'GrandVoile',
      'grand-voile',
      'GV'
    ]) {
      assert.equal(sailRole(name), 'main', name);
    }
    for (const name of ['Jib', 'Genoa', 'Headsail', 'Foresail', 'sail_jib', 'Foc', 'Génois']) {
      assert.equal(sailRole(name), 'jib', name);
    }
  });

  it('ignores case, spaces, punctuation and the number a modelling tool adds to a copy', () => {
    for (const name of [
      'MAINSAIL',
      'mainsail',
      'Main Sail',
      'Mainsail.001',
      'Mainsail001',
      'Mainsail_2'
    ]) {
      assert.equal(sailRole(name), 'main', name);
    }
    assert.equal(sailRole('JIB.003'), 'jib');
  });

  it('leaves everything else alone', () => {
    for (const name of [
      'Hull',
      'Mast',
      'Boom',
      'Mainsheet',
      'Spinnaker',
      'Scene',
      '',
      null,
      undefined,
      '123'
    ]) {
      assert.equal(sailRole(name), null, String(name));
    }
  });

  it('trims the headsail a little less than the mainsail', () => {
    assert.equal(SAIL_ROLES.main.factor, 1);
    assert.ok(SAIL_ROLES.jib.factor > 0 && SAIL_ROLES.jib.factor < 1);
  });
});

const node = (name, ...children) => ({ name, children });

describe('finding the sails in a model', () => {
  it('walks the whole tree, at any depth', () => {
    const root = node(
      'Scene',
      node('Boat', node('Hull'), node('Rig', node('Mast'), node('Mainsail'))),
      node('Jib')
    );
    assert.deepEqual(
      findSails(root).map(({ role }) => role),
      ['main', 'jib']
    );
  });

  it('gives the node itself, so it can be turned', () => {
    const sail = node('Mainsail');
    assert.equal(findSails(node('Scene', sail))[0].node, sail);
  });

  it('turns only the outermost of nested sails', () => {
    const inner = node('Jib');
    const outer = node('Mainsail', inner);
    const found = findSails(node('Scene', outer));
    assert.equal(found.length, 1);
    assert.equal(found[0].node, outer);
  });

  it('finds nothing in a model with no sails named', () => {
    assert.deepEqual(findSails(node('Scene', node('Hull'), node('Mast'))), []);
  });

  it('copes with a node with no children', () => {
    assert.deepEqual(findSails({ name: 'Scene' }), []);
  });
});
