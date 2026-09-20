// How the 3D boat sits and moves: its heading, its heel, how its sails are set.
//
// The track carries a heading and the wind, and nothing about heel, pitch or
// sail trim, so those are worked out here from the wind and made to move as a
// pure function of the frame — nothing reads a clock, which is what keeps an
// export the same film however long it took to render (SPEC §4.12).
//
// No vendor imports, no DOM: plain Node can test this.

const DEGREES = Math.PI / 180;

// The steepest the boat is ever leaned, in a hard breeze on the wind.
export const MAX_HEEL = 22 * DEGREES;

// True wind at which the heel is at its greatest (17 kn).
export const FULL_HEEL_WIND = 9;

// The boat rides waves: it pitches (bow up and down), rolls a little either side of
// its heel, and rises and falls. The track knows nothing of the sea, so the motion
// is made up — a sum of two slow swells whose periods do not divide each other, so
// it never quite repeats and does not read as a metronome — but it is a pure
// function of the film's own time, in units (a second of video at x1). The pace is
// then the eye's, whatever the sailing speed was, and an export is the same
// however long it took to render.
export const MAX_PITCH = 3.6 * DEGREES;
export const MAX_ROLL_SWAY = 2.4 * DEGREES;
// The boat's rise and fall, in boat lengths.
export const MAX_HEAVE = 0.007;

// Film units a swell takes to pass: the periods of the pitch, the roll and the
// heave, each with a slower companion. The roll is slower than the pitch, as a
// boat's is.
export const WAVE_PERIODS = {
  pitch: [2.4, 3.9],
  roll: [3.3, 5.6]
};

// How much of the sea a swell shows in the pitch and how much its companion adds.
const MAIN = 0.75;
const COMPANION = 0.35;
const NORMALISE = 1 / (MAIN + COMPANION);

function swell([main, companion], at, phase) {
  return (
    (MAIN * Math.sin((2 * Math.PI * at) / main + phase) +
      COMPANION * Math.sin((2 * Math.PI * at) / companion + phase * 2.3 + 1.3)) *
    NORMALISE
  );
}

// Each from -1 to 1.
export function wavePitch(at) {
  return swell(WAVE_PERIODS.pitch, at, 0);
}

export function waveRoll(at) {
  return swell(WAVE_PERIODS.roll, at, 0.5);
}

// The boat rises as its bow comes up: a quarter of a swell ahead of the pitch.
export function waveHeave(at) {
  return swell(WAVE_PERIODS.pitch, at, Math.PI / 2);
}

// How much sea there is to ride: none for a boat at rest in port, more the
// faster it goes, and more again in a breeze. From 0 to 1.
export function seaState(state) {
  const way = clamp01((state.sog ?? 0) / 1.5);
  const breeze = 0.55 + 0.45 * clamp01((state.tws ?? 0) / 10);
  return way * breeze;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

// Heel is greatest on the wind and fades as the boat bears away: nothing
// between a beam reach and a run leans a boat over.
export function heelFactor(awa) {
  const angle = Math.abs(awa);
  const rising = clamp01((angle - 10 * DEGREES) / (25 * DEGREES));
  const falling = clamp01((170 * DEGREES - angle) / (75 * DEGREES));
  return rising * falling;
}

// The rotation about the bow axis, positive leaning to starboard. Wind on the
// starboard side (a positive apparent angle) leans the boat to port.
export function heelAngle(awa, tws) {
  if (!Number.isFinite(awa) || !Number.isFinite(tws)) {
    return 0;
  }
  const strength = clamp01(tws / FULL_HEEL_WIND) ** 1.4;
  return -Math.sign(awa) * MAX_HEEL * strength * heelFactor(awa);
}

// The angle of the sails from the boat's centreline, as a rotation about the
// vertical axis. They are let out as the wind comes aft, and sit on the side
// away from the wind: wind from starboard puts the boom to port.
export function sailAngle(awa) {
  if (!Number.isFinite(awa)) {
    return 0;
  }
  const trim = Math.max(4 * DEGREES, Math.min(88 * DEGREES, Math.abs(awa) * 0.5));
  return -Math.sign(awa || 1) * trim;
}

// `at` is the film's own time, in units: what the rocking is a function of.
export function boatPose(state, at, fallbackBearing = 0) {
  const heading = state.heading ?? state.cog ?? fallbackBearing;
  const sea = seaState(state);
  return {
    heading,
    heel: heelAngle(state.awa, state.tws) + MAX_ROLL_SWAY * sea * waveRoll(at),
    pitch: MAX_PITCH * sea * wavePitch(at) || 0,
    lift: MAX_HEAVE * sea * waveHeave(at) || 0,
    sail: sailAngle(state.awa),
    sailed: Number.isFinite(state.awa)
  };
}
