import { html, useEffect, useRef, useState } from '../../../vendor/preact-htm.mjs';
import { useLocale } from '../../../js/context.mjs';
import { createStrokeRecorder, strokeWidth } from '../strokes.mjs';
import { EraserIcon, FinePenIcon, HighlighterIcon, ThickPenIcon, UndoIcon } from './Icons.mjs';

// Presets for the toolbar: base width in canvas CSS pixels, before pressure
// scaling (SPEC §4.4). Only the highlighter is drawn with transparency.
const TOOLS = {
  fine: { kind: 'pen', width: 2.5, icon: FinePenIcon, labelKey: 'entry.toolFine' },
  large: { kind: 'pen', width: 5.5, icon: ThickPenIcon, labelKey: 'entry.toolLarge' },
  highlighter: {
    kind: 'highlighter',
    width: 16,
    icon: HighlighterIcon,
    labelKey: 'entry.toolHighlighter'
  }
};
const TOOL_ORDER = ['fine', 'large', 'highlighter'];
const HIGHLIGHTER_ALPHA = 0.35;
const ERASER_RADIUS = 12;
const DEFAULT_COLOR = '#0f1b26';

// The first choice keeps the theme's ink colour (so a note drawn without
// picking a colour looks the same as before this toolbar existed); the rest
// are fixed so the note looks the same everywhere it is later shown.
const COLORS = [
  { id: 'auto', value: null, labelKey: 'entry.colorDefault' },
  { id: 'blue', value: '#1d4ed8', labelKey: 'entry.colorBlue' },
  { id: 'red', value: '#dc2626', labelKey: 'entry.colorRed' },
  { id: 'green', value: '#16a34a', labelKey: 'entry.colorGreen' },
  { id: 'amber', value: '#d97706', labelKey: 'entry.colorAmber' }
];

function toHex(cssColor) {
  const channels = cssColor.match(/\d+/g);
  if (!channels) {
    return DEFAULT_COLOR;
  }
  return `#${channels
    .slice(0, 3)
    .map((channel) => Number(channel).toString(16).padStart(2, '0'))
    .join('')}`;
}

function drawStroke(context, stroke) {
  const { points } = stroke;
  const base = stroke.width ?? TOOLS.fine.width;
  context.strokeStyle = stroke.color ?? DEFAULT_COLOR;
  context.fillStyle = stroke.color ?? DEFAULT_COLOR;
  context.globalAlpha = stroke.tool === 'highlighter' ? HIGHLIGHTER_ALPHA : 1;
  if (points.length === 1) {
    const [point] = points;
    context.beginPath();
    context.arc(point.x, point.y, strokeWidth(base, point.pressure) / 2, 0, Math.PI * 2);
    context.fill();
  } else {
    for (let i = 1; i < points.length; i += 1) {
      const from = points[i - 1];
      const to = points[i];
      context.lineWidth = strokeWidth(base, to.pressure);
      context.beginPath();
      context.moveTo(from.x, from.y);
      context.lineTo(to.x, to.y);
      context.stroke();
    }
  }
  context.globalAlpha = 1;
}

export function SketchPanel({ busy, onLog, night }) {
  const { t } = useLocale();
  const canvas = useRef(null);
  const recorder = useRef(createStrokeRecorder());
  const activePointer = useRef(null);
  // Once a pen has touched the canvas, fingers are the palm resting on it.
  const penSeen = useRef(false);
  const [tool, setTool] = useState('fine');
  const [color, setColor] = useState(COLORS[0]);
  const [strokeCount, setStrokeCount] = useState(0);
  const [canUndo, setCanUndo] = useState(false);
  const [comment, setComment] = useState('');

  function syncState() {
    setStrokeCount(recorder.current.strokes.length);
    setCanUndo(recorder.current.canUndo());
  }

  function resolveColor() {
    return color.value ?? toHex(getComputedStyle(canvas.current).color);
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
    const drawing = element.getContext('2d');
    drawing.lineCap = 'round';
    drawing.lineJoin = 'round';
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
  // Also covers a WebKit bug (https://bugs.webkit.org/show_bug.cgi?id=217430): with
  // Scribble on, Safari can swallow a pen's pointer events mid-stroke unless the
  // underlying touchstart/touchmove is prevented directly, not just the pointer one.
  const suppressDefault = (event) => event.preventDefault();

  const onPointerDown = (event) => {
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
      if (tool !== 'eraser') {
        recorder.current.end();
      }
      activePointer.current = null;
    }
    if (busy) {
      return;
    }
    canvas.current.setPointerCapture(event.pointerId);
    activePointer.current = event.pointerId;
    const [x, y] = locate(event);
    if (tool === 'eraser') {
      recorder.current.beginErase();
      if (recorder.current.eraseAt(x, y, ERASER_RADIUS)) {
        redraw();
      }
      syncState();
      return;
    }
    const style = { color: resolveColor(), tool: TOOLS[tool].kind, width: TOOLS[tool].width };
    recorder.current.begin(x, y, event.timeStamp, pressureOf(event), style);
    redraw();
    syncState();
  };

  const onPointerMove = (event) => {
    if (event.pointerId !== activePointer.current) {
      return;
    }
    const samples = event.getCoalescedEvents?.() ?? [];
    const list = samples.length > 0 ? samples : [event];
    if (tool === 'eraser') {
      let changed = false;
      for (const sample of list) {
        const [x, y] = locate(sample);
        changed = recorder.current.eraseAt(x, y, ERASER_RADIUS) || changed;
      }
      if (changed) {
        redraw();
        syncState();
      }
      return;
    }
    for (const sample of list) {
      const [x, y] = locate(sample);
      recorder.current.extend(x, y, sample.timeStamp, pressureOf(sample));
    }
    redraw();
  };

  const onPointerUp = (event) => {
    if (event.pointerId !== activePointer.current) {
      return;
    }
    activePointer.current = null;
    if (tool !== 'eraser') {
      recorder.current.end();
    }
    syncState();
  };

  const undo = () => {
    recorder.current.undo();
    redraw();
    syncState();
  };

  const clear = () => {
    recorder.current.clear();
    setComment('');
    redraw();
    syncState();
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
      <div class="sketch-toolbar" role="toolbar" aria-label=${t('entry.sketchTools')}>
        <div class="sketch-tools">
          ${TOOL_ORDER.map((key) => {
            const preset = TOOLS[key];
            const Icon = preset.icon;
            return html`<button
              type="button"
              key=${key}
              class="tool-button icon-button"
              aria-pressed=${tool === key}
              aria-label=${t(preset.labelKey)}
              onClick=${() => setTool(key)}
            >
              <${Icon} />
            </button>`;
          })}
          <button
            type="button"
            class="tool-button icon-button"
            aria-pressed=${tool === 'eraser'}
            aria-label=${t('entry.toolEraser')}
            onClick=${() => setTool('eraser')}
          >
            <${EraserIcon} />
          </button>
          <button
            type="button"
            class="tool-button icon-button"
            disabled=${!canUndo}
            aria-label=${t('entry.sketchUndo')}
            onClick=${undo}
          >
            <${UndoIcon} />
          </button>
        </div>
        ${
          !night &&
          html`<div class="sketch-colors">
          ${COLORS.map(
            (option) => html`<button
              type="button"
              key=${option.id}
              class="color-swatch"
              style=${{ background: option.value ?? 'var(--ink)' }}
              aria-pressed=${color.id === option.id}
              aria-label=${t(option.labelKey)}
              onClick=${() => setColor(option)}
            ></button>`
          )}
        </div>`
        }
      </div>
      <div class="sketch-surface">
        <canvas
          ref=${canvas}
          class="sketch-canvas ${tool === 'eraser' ? 'erasing' : ''}"
          role="img"
          aria-label=${t('entry.sketchArea')}
          onPointerDown=${onPointerDown}
          onPointerMove=${onPointerMove}
          onPointerUp=${onPointerUp}
          onPointerCancel=${onPointerUp}
          onContextMenu=${suppressDefault}
          onSelectStart=${suppressDefault}
          onDragStart=${suppressDefault}
          onTouchStart=${suppressDefault}
          onTouchMove=${suppressDefault}
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
