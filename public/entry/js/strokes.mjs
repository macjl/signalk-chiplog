// Records a handwritten note as vector strokes, the format the logbook stores
// (SPEC §4.4): points in CSS pixels of the canvas, t in milliseconds from the
// first point of the note, pressure only from a pen.

// Rounded through toFixed: multiplying back by a step leaves 38.800000000000004.
const round = (value, digits) => Number(value.toFixed(digits));

export function createStrokeRecorder() {
  let strokes = [];
  let current = null;
  let origin = null;

  function point(x, y, time, pressure) {
    origin ??= time;
    const recorded = { x: round(x, 1), y: round(y, 1), t: Math.round(time - origin) };
    if (typeof pressure === 'number' && Number.isFinite(pressure)) {
      recorded.pressure = round(Math.min(Math.max(pressure, 0), 1), 2);
    }
    return recorded;
  }

  return {
    begin(x, y, time, pressure) {
      current = { points: [point(x, y, time, pressure)] };
      strokes.push(current);
      return current;
    },

    extend(x, y, time, pressure) {
      if (!current) {
        return null;
      }
      const next = point(x, y, time, pressure);
      const last = current.points.at(-1);
      if (last.x !== next.x || last.y !== next.y) {
        current.points.push(next);
      }
      return current;
    },

    end() {
      current = null;
    },

    undo() {
      current = null;
      strokes.pop();
      if (strokes.length === 0) {
        origin = null;
      }
    },

    clear() {
      strokes = [];
      current = null;
      origin = null;
    },

    get strokes() {
      return strokes;
    },

    isEmpty() {
      return strokes.length === 0;
    },

    payload({ width, height }) {
      return {
        strokes: strokes.map((stroke) => ({ points: stroke.points.map((p) => ({ ...p })) })),
        width: Math.round(width),
        height: Math.round(height)
      };
    }
  };
}

// Pen width for a pressure: a firm stroke is up to twice as thick, and input
// without pressure (finger, mouse) draws at the base width.
export function strokeWidth(base, pressure) {
  return typeof pressure === 'number' ? base * (0.5 + pressure * 1.5) : base;
}
