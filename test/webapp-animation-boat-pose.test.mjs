import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  boatPose,
  FULL_HEEL_WIND,
  heelAngle,
  heelFactor,
  MAX_HEAVE,
  MAX_HEEL,
  MAX_PITCH,
  MAX_ROLL_SWAY,
  sailAngle,
  seaState,
  waveHeave,
  wavePitch,
  waveRoll,
  WAVE_PERIODS
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
    assert.notEqual(boatPose(moving, 1).pitch, boatPose(moving, 1.6).pitch);
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

describe('waves', () => {
  const samples = Array.from({ length: 600 }, (unused, i) => i * 0.1);

  it('keep every swell between -1 and 1, and are never still', () => {
    for (const wave of [wavePitch, waveRoll, waveHeave]) {
      const values = samples.map(wave);
      assert.ok(values.every((value) => Math.abs(value) <= 1 + 1e-9));
      assert.ok(Math.max(...values) > 0.8 && Math.min(...values) < -0.8);
    }
  });

  it('rock the bow up and down a few degrees, and the roll less than the pitch', () => {
    assert.ok(MAX_PITCH > 2 * (Math.PI / 180) && MAX_PITCH < 6 * (Math.PI / 180));
    assert.ok(MAX_ROLL_SWAY < MAX_PITCH);
    const moving = { sog: 3, tws: 8 };
    const poses = samples.map((at) => boatPose(moving, at));
    assert.ok(poses.some((pose) => pose.pitch > MAX_PITCH * 0.5));
    assert.ok(poses.some((pose) => pose.pitch < -MAX_PITCH * 0.5));
    assert.ok(poses.every((pose) => Math.abs(pose.pitch) <= MAX_PITCH + 1e-9));
    assert.ok(poses.every((pose) => Math.abs(pose.lift) <= MAX_HEAVE + 1e-9));
    // With no wind reading there is no heel, so the roll is all sway.
    assert.ok(poses.every((pose) => Math.abs(pose.heel) <= MAX_ROLL_SWAY + 1e-9));
    assert.ok(Math.max(...poses.map((pose) => Math.abs(pose.heel))) > MAX_ROLL_SWAY * 0.5);
  });

  it('roll either side of the heel, not just towards one side', () => {
    const moving = { sog: 3, tws: 8, awa: 0.9 };
    const heels = samples.map((at) => boatPose(moving, at).heel);
    const steady = boatPose({ ...moving, sog: 0 }, 0).heel;
    assert.ok(heels.some((heel) => heel > steady) && heels.some((heel) => heel < steady));
  });

  it('never quite repeat: the two swells do not share a period', () => {
    const [main, companion] = WAVE_PERIODS.pitch;
    assert.notEqual(main / companion, Math.round(main / companion));
    assert.ok(Math.abs(wavePitch(3) - wavePitch(3 + main)) > 1e-3);
  });

  it('are the same at the same instant, whatever came before', () => {
    assert.equal(wavePitch(12.34), wavePitch(12.34));
    assert.deepEqual(boatPose({ sog: 3, tws: 8 }, 7.7), boatPose({ sog: 3, tws: 8 }, 7.7));
  });

  it('are bigger the faster the boat goes and the windier it is, and nothing at rest', () => {
    assert.equal(seaState({ sog: 0, tws: 15 }), 0);
    assert.ok(seaState({ sog: 3, tws: 4 }) < seaState({ sog: 3, tws: 12 }));
    assert.ok(seaState({ sog: 0.5, tws: 8 }) < seaState({ sog: 3, tws: 8 }));
    assert.ok(seaState({ sog: 9, tws: 30 }) <= 1);
    // A track with no wind reading still has some sea.
    assert.ok(seaState({ sog: 3 }) > 0);
  });
});
