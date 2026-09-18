import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createFormatter } from '../public/js/format.mjs';
import { createTranslator } from '../public/js/i18n.mjs';
import {
  bearingRadians,
  compassPoint,
  distanceMetres,
  KIND_RANGE_M,
  landmarkLine,
  nearestLandmark,
  relevantRange
} from '../public/js/landmarks.mjs';

const METRES_PER_NM = 1852;

// The lighthouse of the user's own waters, and the cape it stands on.
const CAP_FERRET = {
  id: 1,
  name: 'Phare du Cap-Ferret',
  kind: 'lighthouse',
  position: { lat: 44.6459646, lon: -1.2488154 },
  lightRange: 22 * METRES_PER_NM
};
const POINTE_AIGUILLON = {
  id: 2,
  name: "Pointe de l'Aiguillon",
  kind: 'cape',
  position: { lat: 44.652747, lon: -1.1394754 },
  lightRange: null
};
const PETIT_PORT = {
  id: 3,
  name: 'Petit Port',
  kind: 'harbour',
  position: { lat: 44.6616892, lon: -1.1527159 },
  lightRange: null
};

function formatter(language) {
  const t = createTranslator(language);
  return {
    t,
    format: createFormatter({
      locale: language,
      units: { knots: t('unit.knots'), nauticalMiles: t('unit.nauticalMiles') },
      timeZone: 'UTC'
    })
  };
}

// A position a given distance and bearing from another, to build cases with.
function offset({ lat, lon }, metres, degrees) {
  const radians = (degrees * Math.PI) / 180;
  const north = (metres * Math.cos(radians)) / 111320;
  const east = (metres * Math.sin(radians)) / (111320 * Math.cos((lat * Math.PI) / 180));
  return { lat: lat + north, lon: lon + east };
}

describe('landmark bearings', () => {
  it('measure the distance and the bearing from the landmark to the boat', () => {
    const boat = offset(CAP_FERRET.position, 2 * METRES_PER_NM, 53);

    assert.ok(Math.abs(distanceMetres(CAP_FERRET.position, boat) - 2 * METRES_PER_NM) < 5);
    const degrees = (bearingRadians(CAP_FERRET.position, boat) * 180) / Math.PI;
    assert.ok(Math.abs(degrees - 53) < 0.5, `${degrees} is about 53`);
  });

  it('name the compass point to sixteenths, the way a rose reads', () => {
    const point = (degrees) => compassPoint((degrees * Math.PI) / 180);
    assert.equal(point(0), 'n');
    assert.equal(point(53), 'ne');
    assert.equal(point(70), 'ene');
    assert.equal(point(180), 's');
    assert.equal(point(225), 'sw');
    assert.equal(point(359), 'n');
  });

  it('take a landmark no further out than its kind, or its light, carries', () => {
    assert.equal(relevantRange(CAP_FERRET), KIND_RANGE_M.lighthouse);
    assert.equal(relevantRange({ kind: 'lighthouse', lightRange: 4 * METRES_PER_NM }), 4 * 1852);
    assert.equal(relevantRange(POINTE_AIGUILLON), KIND_RANGE_M.cape);
  });

  describe('choosing the landmark', () => {
    const landmarks = [CAP_FERRET, POINTE_AIGUILLON, PETIT_PORT];

    it('prefers the lighthouse two miles off to the harbour two and a half away', () => {
      // Both are in range, but a harbour says little from that far out.
      const boat = offset(CAP_FERRET.position, 2 * METRES_PER_NM, 53);

      assert.equal(nearestLandmark(boat, landmarks).landmark.name, 'Phare du Cap-Ferret');
    });

    it('takes the harbour once inside it', () => {
      const boat = offset(PETIT_PORT.position, 80, 20);

      assert.equal(nearestLandmark(boat, landmarks).landmark.name, 'Petit Port');
    });

    it('has nothing to say out of range of every landmark', () => {
      const offshore = offset(CAP_FERRET.position, 30 * METRES_PER_NM, 270);

      assert.equal(nearestLandmark(offshore, landmarks), null);
      assert.equal(nearestLandmark(null, landmarks), null);
      assert.equal(nearestLandmark(CAP_FERRET.position, []), null);
    });
  });

  describe('the line shown under a position', () => {
    it('gives the distance, the compass point, the bearing and the name', () => {
      const boat = offset(CAP_FERRET.position, 2 * METRES_PER_NM, 53);

      assert.equal(
        landmarkLine(boat, [CAP_FERRET], formatter('en')),
        '2.0 nm NE (053°) — Phare du Cap-Ferret'
      );
      assert.equal(
        landmarkLine(boat, [CAP_FERRET], formatter('fr')),
        '2,0 M NE (053°) — Phare du Cap-Ferret'
      );
    });

    it('reads in metres close in, where a tenth of a mile says nothing', () => {
      const boat = offset(PETIT_PORT.position, 140, 315);

      assert.equal(
        landmarkLine(boat, [PETIT_PORT], formatter('en')),
        '140 m NW (315°) — Petit Port'
      );
      assert.equal(
        landmarkLine(boat, [PETIT_PORT], formatter('fr')),
        '140 m NO (315°) — Petit Port'
      );
    });

    it('is the name alone when the boat is at the landmark', () => {
      assert.equal(landmarkLine(PETIT_PORT.position, [PETIT_PORT], formatter('fr')), 'Petit Port');
    });

    it('is nothing at all with no landmark in range', () => {
      assert.equal(landmarkLine({ lat: 44, lon: -8 }, [CAP_FERRET], formatter('en')), null);
    });
  });
});
