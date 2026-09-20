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

// A gentle pitch and lift, in film units: one unit is a second of video at x1,
// so the boat rocks at a pace the eye follows whatever the sailing speed was.
export const BOB_PERIOD_UNITS = 2.6;
export const MAX_PITCH = 1.6 * DEGREES;
export const MAX_ROLL_SWAY = 1.1 * DEGREES;

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
  const phase = (2 * Math.PI * at) / BOB_PERIOD_UNITS;
  // Only a moving boat rocks; one at rest in port is still.
  const motion = clamp01((state.sog ?? 0) / 1.5);
  return {
    heading,
    heel: heelAngle(state.awa, state.tws) + MAX_ROLL_SWAY * motion * Math.sin(phase * 0.7 + 1),
    pitch: MAX_PITCH * motion * Math.sin(phase) || 0,
    lift: 0.004 * motion * Math.sin(phase + 0.6) || 0,
    sail: sailAngle(state.awa),
    sailed: Number.isFinite(state.awa)
  };
}
