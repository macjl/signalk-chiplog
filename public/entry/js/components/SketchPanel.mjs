import { html, useEffect, useRef, useState } from '../../../vendor/preact-htm.mjs';
import { useLocale } from '../../../js/context.mjs';
import { createStrokeRecorder, strokeWidth } from '../strokes.mjs';

const BASE_WIDTH = 2.5;

function drawStroke(context, stroke) {
  const { points } = stroke;
  if (points.length === 1) {
    const [point] = points;
    context.beginPath();
    context.arc(point.x, point.y, strokeWidth(BASE_WIDTH, point.pressure) / 2, 0, Math.PI * 2);
    context.fill();
    return;
  }
  for (let i = 1; i < points.length; i += 1) {
    const from = points[i - 1];
    const to = points[i];
    context.lineWidth = strokeWidth(BASE_WIDTH, to.pressure);
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
  }
}

export function SketchPanel({ busy, onLog }) {
  const { t } = useLocale();
  const canvas = useRef(null);
  const recorder = useRef(createStrokeRecorder());
  const activePointer = useRef(null);
  // Once a pen has touched the canvas, fingers are the palm resting on it.
  const penSeen = useRef(false);
  const [strokeCount, setStrokeCount] = useState(0);
  const [comment, setComment] = useState('');

  function context() {
    const element = canvas.current;
    const drawing = element.getContext('2d');
    drawing.lineCap = 'round';
    drawing.lineJoin = 'round';
    const colour = getComputedStyle(element).color;
    drawing.strokeStyle = colour;
    drawing.fillStyle = colour;
    return drawing;
  }

  function redraw() {
    const element = canvas.current;
    if (!element) {
      return;
    }
    const ratio = window.devicePixelRatio || 1;
    const { width, height } = element.getBoundingClientRect();
    element.width = Math.round(width * ratio);
    element.height = Math.round(height * ratio);
    const drawing = context();
    drawing.setTransform(ratio, 0, 0, ratio, 0, 0);
    drawing.clearRect(0, 0, width, height);
    recorder.current.strokes.forEach((stroke) => drawStroke(drawing, stroke));
  }

  useEffect(() => {
    redraw();
    const observer = new ResizeObserver(redraw);
    observer.observe(canvas.current);
    return () => observer.disconnect();
  }, []);

  const locate = (event) => {
    const box = canvas.current.getBoundingClientRect();
    return [event.clientX - box.left, event.clientY - box.top];
  };
  const pressureOf = (event) => (event.pointerType === 'pen' ? event.pressure : undefined);

  // Belt-and-braces alongside the CSS `user-select`/`-webkit-touch-callout: none`:
  // some iOS Safari versions still raise the selection/lookup callout on a long
  // press over the canvas despite that CSS, so block it at the event level too.
  const suppressDefault = (event) => event.preventDefault();

  const onPointerDown = (event) => {
    // Every contact on the canvas must be prevented, even ones we reject (the palm) —
    // otherwise the browser can hand an un-prevented touch to its own gesture
    // recognizer, which on some builds cancels the pen's in-progress pointer.
    event.preventDefault();
    if (event.pointerType === 'pen') {
      penSeen.current = true;
    } else if (event.pointerType === 'touch' && penSeen.current) {
      return;
    }
    if (activePointer.current !== null) {
      if (event.pointerType !== 'pen') {
        return;
      }
      // A pen can only touch one point at a time, so a new pen contact means the
      // previous one has lifted even if its pointerup/pointercancel hasn't arrived
      // yet — quickly reapplying the pen can reorder those events. Finish the
      // stale stroke instead of silently dropping the new one.
      recorder.current.end();
      setStrokeCount(recorder.current.strokes.length);
      activePointer.current = null;
    }
    if (busy) {
      return;
    }
    canvas.current.setPointerCapture(event.pointerId);
    activePointer.current = event.pointerId;
    const [x, y] = locate(event);
    const stroke = recorder.current.begin(x, y, event.timeStamp, pressureOf(event));
    const drawing = context();
    drawing.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
    drawStroke(drawing, stroke);
  };

  const onPointerMove = (event) => {
    if (event.pointerId !== activePointer.current) {
      return;
    }
    const samples = event.getCoalescedEvents?.() ?? [];
    const drawing = context();
    drawing.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
    for (const sample of samples.length > 0 ? samples : [event]) {
      const [x, y] = locate(sample);
      const stroke = recorder.current.extend(x, y, sample.timeStamp, pressureOf(sample));
      const { points } = stroke;
      if (points.length > 1) {
        drawStroke(drawing, { points: points.slice(-2) });
      }
    }
  };

  const onPointerUp = (event) => {
    if (event.pointerId !== activePointer.current) {
      return;
    }
    activePointer.current = null;
    recorder.current.end();
    setStrokeCount(recorder.current.strokes.length);
  };

  const undo = () => {
    recorder.current.undo();
    setStrokeCount(recorder.current.strokes.length);
    redraw();
  };

  const clear = () => {
    recorder.current.clear();
    setStrokeCount(0);
    setComment('');
    redraw();
  };

  const send = async () => {
    const box = canvas.current.getBoundingClientRect();
    const body = { type: 'handwritten_annotation', payload: recorder.current.payload(box) };
    if (comment.trim()) {
      body.comment = comment.trim();
    }
    if (await onLog(body, t('event.handwritten'))) {
      clear();
    }
  };

  return html`
    <div class="sketch">
      <div class="sketch-surface">
        <canvas
          ref=${canvas}
          class="sketch-canvas"
          role="img"
          aria-label=${t('entry.sketchArea')}
          onPointerDown=${onPointerDown}
          onPointerMove=${onPointerMove}
          onPointerUp=${onPointerUp}
          onPointerCancel=${onPointerUp}
          onContextMenu=${suppressDefault}
          onSelectStart=${suppressDefault}
          onDragStart=${suppressDefault}
        ></canvas>
        ${strokeCount === 0 && html`<span class="sketch-hint" aria-hidden="true">${t('entry.sketchHint')}</span>`}
      </div>
      <input
        class="sketch-comment"
        value=${comment}
        maxlength="10000"
        placeholder=${t('entry.comment')}
        aria-label=${t('entry.comment')}
        onInput=${(event) => setComment(event.currentTarget.value)}
      />
      <div class="sketch-actions">
        <button type="button" class="tool-button" disabled=${strokeCount === 0} onClick=${undo}>
          ${t('entry.sketchUndo')}
        </button>
        <button type="button" class="tool-button" disabled=${strokeCount === 0} onClick=${clear}>
          ${t('entry.sketchClear')}
        </button>
        <button type="button" class="big-button primary" disabled=${busy || strokeCount === 0} onClick=${send}>
          ${t('entry.send')}
        </button>
      </div>
    </div>
  `;
}
