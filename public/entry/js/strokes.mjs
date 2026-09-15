// Records a handwritten note as vector strokes, the format the logbook stores
// (SPEC §4.4): points in CSS pixels of the canvas, t in milliseconds from the
// first point of the note, pressure only from a pen. A stroke also carries the
// tool it was drawn with — color, tool ('pen'/'highlighter') and base width —
// so the webapp and PDF can reproduce it, not just the tablet.

// Rounded through toFixed: multiplying back by a step leaves 38.800000000000004.
const round = (value, digits) => Number(value.toFixed(digits));

// Shortest distance from (px, py) to the segment (x1, y1)-(x2, y2).
function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSquared));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

export function createStrokeRecorder() {
  let strokes = [];
  let current = null;
  let origin = null;
  let history = [];

  function point(x, y, time, pressure) {
    origin ??= time;
    const recorded = { x: round(x, 1), y: round(y, 1), t: Math.round(time - origin) };
    if (typeof pressure === 'number' && Number.isFinite(pressure)) {
      recorded.pressure = round(Math.min(Math.max(pressure, 0), 1), 2);
    }
    return recorded;
  }

  // Snapshots the strokes as they are now, so a single `undo()` can restore
  // them after either a finished pen stroke or a whole eraser gesture.
  function pushHistory() {
    history.push(
      strokes.map((stroke) => ({ ...stroke, points: stroke.points.map((p) => ({ ...p })) }))
    );
  }

  return {
    begin(x, y, time, pressure, style) {
      pushHistory();
      current = { points: [point(x, y, time, pressure)], ...style };
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

    // Call once when an eraser gesture starts, then `eraseAt` for each move:
    // the whole gesture undoes as one action, like a finished pen stroke.
    beginErase() {
      pushHistory();
    },

    // Removes any point of any stroke within `radius` of (x, y), splitting a
    // stroke in two where the erased portion was in its middle. Returns
    // whether anything was actually erased.
    eraseAt(x, y, radius) {
      let changed = false;
      const next = [];
      for (const stroke of strokes) {
        const { points } = stroke;
        let run = [];
        const flushRun = () => {
          if (run.length > 0) {
            next.push({ ...stroke, points: run });
            run = [];
          }
        };
        // Tested against the last point actually kept, not the original array: once a
        // point is erased, the segment picks up from before it, so a straight line
        // erased in its middle still splits into two, instead of eating one more
        // point than intended on the far side of the gap.
        for (const candidate of points) {
          const kept = run.at(-1);
          const hit = kept
            ? distanceToSegment(x, y, kept.x, kept.y, candidate.x, candidate.y) <= radius
            : Math.hypot(candidate.x - x, candidate.y - y) <= radius;
          if (hit) {
            changed = true;
            flushRun();
          } else {
            run.push(candidate);
          }
        }
        flushRun();
      }
      if (changed) {
        strokes = next;
        current = null;
      }
      return changed;
    },

    undo() {
      strokes = history.pop() ?? [];
      current = null;
      if (strokes.length === 0) {
        origin = null;
      }
    },

    clear() {
      strokes = [];
      current = null;
      origin = null;
      history = [];
    },

    get strokes() {
      return strokes;
    },

    canUndo() {
      return history.length > 0;
    },

    isEmpty() {
      return strokes.length === 0;
    },

    payload({ width, height }) {
      return {
        strokes: strokes.map((stroke) => ({
          points: stroke.points.map((p) => ({ ...p })),
          ...(stroke.color !== undefined ? { color: stroke.color } : {}),
          ...(stroke.tool !== undefined ? { tool: stroke.tool } : {}),
          ...(stroke.width !== undefined ? { width: stroke.width } : {})
        })),
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
