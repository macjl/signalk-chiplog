import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  boatPose,
  BOB_PERIOD_UNITS,
  FULL_HEEL_WIND,
  heelAngle,
  heelFactor,
  MAX_HEEL,
  sailAngle
} from '../public/js/animation/boat-pose.mjs';

const DEGREES = Math.PI / 180;

describe('heel', () => {
  it('leans away from the wind: starboard wind puts the boat over to port', () => {
    // Rotation about the bow is positive towards starboard.
    assert.ok(heelAngle(40 * DEGREES, 8) < 0);
    assert.ok(heelAngle(-40 * DEGREES, 8) > 0);
  });

  it('is greatest on the wind in a breeze, and never beyond the maximum', () => {
    const onTheWind = Math.abs(heelAngle(40 * DEGREES, FULL_HEEL_WIND * 3));
    assert.ok(onTheWind <= MAX_HEEL + 1e-9);
    assert.ok(onTheWind > MAX_HEEL * 0.95);
    assert.ok(Math.abs(heelAngle(40 * DEGREES, 3)) < onTheWind);
  });

  it('fades as the boat bears away, to nothing dead downwind or head to wind', () => {
    assert.ok(heelFactor(40 * DEGREES) > heelFactor(120 * DEGREES));
    assert.equal(heelFactor(0), 0);
    assert.equal(heelFactor(Math.PI), 0);
  });

  it('stays upright when the wind is not known', () => {
    assert.equal(heelAngle(null, 8), 0);
    assert.equal(heelAngle(40 * DEGREES, null), 0);
    assert.equal(heelAngle(undefined, undefined), 0);
  });
});

describe('sail trim', () => {
  it('sets the sails on the side away from the wind', () => {
    assert.ok(sailAngle(60 * DEGREES) < 0);
    assert.ok(sailAngle(-60 * DEGREES) > 0);
  });

  it('lets them out as the wind comes aft, and never past square', () => {
    assert.ok(Math.abs(sailAngle(150 * DEGREES)) > Math.abs(sailAngle(50 * DEGREES)));
    assert.ok(Math.abs(sailAngle(Math.PI)) <= 88 * DEGREES + 1e-9);
  });

  it('keeps them amidships without a wind reading', () => {
    assert.equal(sailAngle(null), 0);
  });
});

describe('boat pose', () => {
  const moving = { heading: 1, cog: 2, sog: 3, awa: 0.7, tws: 8 };

  it('points the way the boat heads, falling back to its course, then to the camera', () => {
    assert.equal(boatPose(moving, 0).heading, 1);
    assert.equal(boatPose({ ...moving, heading: null }, 0).heading, 2);
    assert.equal(boatPose({ sog: 0 }, 0, 0.4).heading, 0.4);
  });

  it('is a pure function of the film time', () => {
    assert.deepEqual(boatPose(moving, 12.34), boatPose(moving, 12.34));
    assert.notEqual(boatPose(moving, 1).pitch, boatPose(moving, 1 + BOB_PERIOD_UNITS / 4).pitch);
  });

  it('repeats every rocking period', () => {
    const a = boatPose(moving, 5);
    const b = boatPose(moving, 5 + BOB_PERIOD_UNITS);
    assert.ok(Math.abs(a.pitch - b.pitch) < 1e-9);
  });

  it('holds a boat at rest still', () => {
    const still = boatPose({ heading: 1, sog: 0 }, 3.7);
    assert.equal(still.pitch, 0);
    assert.equal(still.lift, 0);
  });

  it('says whether the sails are set from a wind reading', () => {
    assert.equal(boatPose(moving, 0).sailed, true);
    assert.equal(boatPose({ heading: 1, sog: 3 }, 0).sailed, false);
  });
});
