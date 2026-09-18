import { html, useRef, useState } from '../../vendor/preact-htm.mjs';
import { useLocale } from '../context.mjs';
import { isMp4ExportSupported, VIDEO_FORMATS } from '../animation/formats.mjs';
import { frameCount, unitsAtFrame, videoDurationSeconds } from '../animation/schedule.mjs';

// How many frames ahead the tiles are asked for while a frame is being encoded.
// Without it every frame would wait on a cold queue; with it the downloads run
// while the encoder works.
const PREFETCH_FRAMES = 6;

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function AnimationExport({
  storyboard,
  formatId,
  onFormatChange,
  speed,
  videoFormat,
  fileName,
  renderScene,
  loadTiles,
  requestTiles
}) {
  const { t, language } = useLocale();
  const [progress, setProgress] = useState(null);
  const [outcome, setOutcome] = useState(null);
  const abort = useRef(null);
  const supported = isMp4ExportSupported();

  const frames = frameCount(storyboard.totalUnits, speed);
  const seconds = videoDurationSeconds(storyboard.totalUnits, speed);
  const durationLabel = `${new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(seconds)} s`;
  const at = (index) => unitsAtFrame(index, storyboard.totalUnits, frames);

  const run = async () => {
    const controller = new AbortController();
    abort.current = controller;
    setOutcome(null);
    setProgress({ done: 0, total: frames });
    try {
      const { canEncodeThisVideo, encodeAnimation } = await import('../animation/mp4.mjs');
      if (!(await canEncodeThisVideo(videoFormat.width, videoFormat.height))) {
        setOutcome({ kind: 'unsupported' });
        return;
      }
      const blob = await encodeAnimation({
        width: videoFormat.width,
        height: videoFormat.height,
        frames,
        signal: controller.signal,
        onProgress: ({ done, total }) => setProgress({ done, total }),
        drawFrame: async (index, context) => {
          // The map this frame needs, waited for before it is drawn: the film
          // is then whole, however slow the connection — a real render, not a
          // screen recording. Tiles for the frames after it are asked for
          // without waiting, so the downloads and the encoder overlap.
          await loadTiles(at(index), controller.signal);
          for (
            let ahead = index + 1;
            ahead <= Math.min(frames - 1, index + PREFETCH_FRAMES);
            ahead += 1
          ) {
            requestTiles(at(ahead), controller.signal);
          }
          renderScene(context, at(index), {
            width: videoFormat.width,
            height: videoFormat.height,
            renderScale: 1
          });
        }
      });
      download(blob, fileName);
      setOutcome({ kind: 'done', name: fileName });
    } catch (error) {
      setOutcome(
        error?.name === 'AbortError'
          ? { kind: 'cancelled' }
          : { kind: 'failed', message: error?.message ?? String(error) }
      );
    } finally {
      abort.current = null;
      setProgress(null);
    }
  };

  const busy = progress !== null;
  const percent =
    busy && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return html`
    <section class="card animation-export">
      <h2>${t('animation.exportTitle')}</h2>
      ${
        supported
          ? html`
              <div class="animation-export-controls">
                <label class="animation-export-format">
                  ${t('animation.exportFormat')}
                  <select
                    disabled=${busy}
                    value=${formatId}
                    onChange=${(event) => onFormatChange(event.currentTarget.value)}
                  >
                    ${VIDEO_FORMATS.map(
                      (option) =>
                        html`<option key=${option.id} value=${option.id}>${t(option.labelKey)}</option>`
                    )}
                  </select>
                </label>
                <p class="muted">
                  ${t('animation.exportHint', {
                    format: `${videoFormat.width}×${videoFormat.height}`,
                    duration: durationLabel,
                    factor: new Intl.NumberFormat(language).format(speed)
                  })}
                </p>
              </div>
              <p class="muted">${t('animation.exportTilesNote')}</p>
              <div class="actions">
                <button type="button" disabled=${busy} onClick=${run}>${t('animation.exportStart')}</button>
                ${
                  busy &&
                  html`<button type="button" class="danger" onClick=${() => abort.current?.abort()}>
                    ${t('common.cancel')}
                  </button>`
                }
              </div>
              ${
                busy &&
                html`<div class="animation-progress">
                  <progress max="100" value=${percent}></progress>
                  <p class="muted">
                    ${t('animation.exportProgress', {
                      percent,
                      frame: progress.done,
                      total: progress.total
                    })}
                  </p>
                </div>`
              }
              <${ExportOutcome} outcome=${outcome} />
            `
          : html`<p class="muted">${t('animation.exportUnsupported')}</p>`
      }
    </section>
  `;
}

function ExportOutcome({ outcome }) {
  const { t } = useLocale();
  if (!outcome) {
    return null;
  }
  if (outcome.kind === 'done') {
    return html`<p class="notice notice-ok">${t('animation.exportDone', { name: outcome.name })}</p>`;
  }
  if (outcome.kind === 'cancelled') {
    return html`<p class="notice">${t('animation.exportCancelled')}</p>`;
  }
  if (outcome.kind === 'unsupported') {
    return html`<p class="notice notice-error">${t('animation.exportUnsupported')}</p>`;
  }
  return html`<p class="notice notice-error">${t('animation.exportFailed', { message: outcome.message })}</p>`;
}
