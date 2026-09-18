import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.mjs';
import { useLocale } from '../context.mjs';
import {
  completeRange,
  monthGrid,
  monthOf,
  monthTitle,
  shiftMonth,
  weekdayLabels
} from '../calendar.mjs';
import { dayKey, rangeBoundary } from '../days.mjs';

// One control for a period: a button showing it, and a calendar to pick it with
// two clicks -- the first and the last day. Either end may be left open by the
// shortcuts around it; a range is only ever changed here by completing one, or
// by clearing it where any date is allowed (`allowAny`).
export function DateRangePicker({ from, to, onChange, label, allowAny = true, disabled = false }) {
  const { t, format, language } = useLocale();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState(() => monthOf(from || dayKey(new Date())));
  // The first click of a range being picked, until the second one arrives.
  const [anchor, setAnchor] = useState(null);
  const [hover, setHover] = useState(null);
  const root = useRef(null);
  const trigger = useRef(null);

  const close = () => {
    setOpen(false);
    setAnchor(null);
    setHover(null);
  };

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const outside = (event) => {
      if (!root.current?.contains(event.target)) {
        close();
      }
    };
    const escape = (event) => {
      if (event.key === 'Escape') {
        close();
        trigger.current?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const toggle = () => {
    if (open) {
      close();
      return;
    }
    setView(monthOf(from || dayKey(new Date())));
    setOpen(true);
  };

  const clear = () => {
    onChange({ from: '', to: '' });
    close();
    trigger.current?.focus();
  };

  const pick = (key) => {
    if (anchor === null) {
      setAnchor(key);
      return;
    }
    onChange(completeRange(anchor, key));
    close();
    trigger.current?.focus();
  };

  // What the calendar highlights: the range being picked, with the day under
  // the pointer as its provisional end, or else the one already chosen.
  const shown = anchor === null ? { from, to } : completeRange(anchor, hover ?? anchor);
  const dayText = (key) => format.date(rangeBoundary(key));
  const summary =
    !from && !to
      ? allowAny
        ? t('range.anyDate')
        : t('range.choose')
      : `${from ? dayText(from) : '…'} – ${to ? dayText(to) : '…'}`;
  const today = dayKey(new Date());

  const cellClass = (key) => {
    const classes = ['cal-day'];
    if (key === today) {
      classes.push('cal-today');
    }
    if (shown.from && shown.to && key >= shown.from && key <= shown.to) {
      classes.push('cal-in-range');
    }
    if (key === shown.from) {
      classes.push('cal-start');
    }
    if (key === shown.to) {
      classes.push('cal-end');
    }
    return classes.join(' ');
  };

  const nav = (delta, name, text) => html`
    <button
      type="button"
      class="cal-nav"
      aria-label=${name}
      onClick=${() => setView(shiftMonth(view, delta))}
    >
      ${text}
    </button>
  `;

  return html`
    <div class="range-picker" ref=${root}>
      <button
        type="button"
        class="range-trigger"
        ref=${trigger}
        aria-haspopup="dialog"
        aria-expanded=${open}
        disabled=${disabled}
        aria-label=${`${label}: ${summary}`}
        onClick=${toggle}
      >
        <span aria-hidden="true">📅</span>
        <span>${summary}</span>
      </button>
      ${
        open &&
        html`
          <div class="range-popover" role="dialog" aria-label=${label}>
            <div class="cal-header">
              ${nav(-12, t('range.previousYear'), '«')}
              ${nav(-1, t('range.previousMonth'), '‹')}
              <strong class="cal-title" aria-live="polite">${monthTitle(language, view)}</strong>
              ${nav(1, t('range.nextMonth'), '›')}
              ${nav(12, t('range.nextYear'), '»')}
            </div>
            <div class="cal-grid" onMouseLeave=${() => setHover(null)}>
              ${weekdayLabels(language).map(
                (name) => html`<span class="cal-weekday" key=${name}>${name}</span>`
              )}
              ${monthGrid(view.year, view.month).map((key, index) =>
                key === null
                  ? html`<span key=${`blank-${index}`}></span>`
                  : html`
                      <button
                        type="button"
                        key=${key}
                        class=${cellClass(key)}
                        aria-label=${format.day(rangeBoundary(key))}
                        aria-pressed=${key === shown.from || key === shown.to}
                        onClick=${() => pick(key)}
                        onMouseEnter=${() => setHover(key)}
                        onFocus=${() => setHover(key)}
                      >
                        ${Number(key.slice(8))}
                      </button>
                    `
              )}
            </div>
            <div class="cal-footer">
              <span class="muted cal-hint">
                ${anchor === null ? t('range.pickStart') : t('range.pickEnd')}
              </span>
              ${
                allowAny &&
                (from || to) &&
                html`<button type="button" class="link-button" onClick=${clear}>
                  ${t('range.anyDate')}
                </button>`
              }
            </div>
          </div>
        `
      }
    </div>
  `;
}
