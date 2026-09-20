import { html, useEffect, useMemo, useRef, useState } from '../../vendor/preact-htm.mjs';
import { fetchAll, get } from '../api.mjs';
import { useLocale } from '../context.mjs';
import { rangeBoundary } from '../days.mjs';
import { trackPoints } from '../track.mjs';
import { loadBoat, MAX_MODEL_BYTES, saveBoat, clearBoat } from '../animation/boat-store.mjs';
import { createProjection, visibleTiles } from '../animation/camera.mjs';
import {
  BOAT_SIZES,
  boatSizeById,
  CAMERA_FRAMINGS,
  DEFAULT_BOAT_SIZE_ID,
  DEFAULT_FRAMING_ID,
  framingById,
  framing3d
} from '../animation/camera3d.mjs';
import { DEFAULT_FORMAT_ID, formatById } from '../animation/formats.mjs';
import { createPlayer } from '../animation/player.mjs';
import { drawFrame } from '../animation/renderer.mjs';
import { SPEEDS } from '../animation/schedule.mjs';
import { buildLegs, buildStoryboard, stateAt } from '../animation/storyboard.mjs';
import { createTileCache, TILE_LAYERS } from '../animation/tiles.mjs';
import { isWebGL2Supported } from '../animation/webgl.mjs';
import { AnimationExport } from './AnimationExport.mjs';
import { DateRangePicker } from './DateRangePicker.mjs';
import { ErrorNotice } from './common.mjs';

const TRACK_CONCURRENCY = 4;

// Tiles keep arriving after a frame is drawn; while any are in the air the
// preview repaints, so the map fills in instead of staying half drawn.
const TILE_REPAINT_MS = 250;

// How far ahead of the boat the preview asks for its map, in animation seconds
// scaled by the playback speed. Without it the camera outruns the downloads and
// the boat sails across an empty frame.
const LOOK_AHEAD_UNITS = 2;

// A 9:16 preview at full page width would be taller than the window; cap it and
// let the canvas narrow instead.
const STAGE_HEIGHT_SHARE = 0.62;
const MIN_STAGE_HEIGHT = 260;

function rangeParams(from, to) {
  const params = new URLSearchParams();
  if (from) {
    params.set('from', rangeBoundary(from).toISOString());
  }
  if (to) {
    params.set('to', rangeBoundary(to, 1).toISOString());
  }
  return params.toString();
}

// A few at a time: a season is dozens of tracks, and the server is a Raspberry
// Pi on a boat.
async function mapWithLimit(items, limit, run) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (let index = next++; index < items.length; index = next++) {
        results[index] = await run(items[index], index);
      }
    })
  );
  return results;
}

export function AnimationView({ from: initialFrom, to: initialTo }) {
  const { t, format, language } = useLocale();
  const [from, setFrom] = useState(initialFrom ?? '');
  const [to, setTo] = useState(initialTo ?? '');
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(null);
  const [passages, setPassages] = useState(null);
  const [error, setError] = useState(null);
  const [formatId, setFormatId] = useState(DEFAULT_FORMAT_ID);
  const [seamarks, setSeamarks] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [units, setUnits] = useState(0);
  const [view, setView] = useState('map');
  const [framingId, setFramingId] = useState(DEFAULT_FRAMING_ID);
  const [boatSizeId, setBoatSizeId] = useState(DEFAULT_BOAT_SIZE_ID);
  // The 3D renderer's module, once loaded: it carries the whole 3D library, so
  // nobody who stays on the map ever downloads it.
  const [engine, setEngine] = useState(null);
  const [notice3d, setNotice3d] = useState(null);
  const [boat, setBoat] = useState({ name: null, problem: null });
  const boatInput = useRef(null);
  const webgl = useMemo(() => isWebGL2Supported(), []);
  // Which canvas the 3D renderer is drawing on, so its WebGL context can be let
  // go of when the page is left rather than waiting for the garbage collector.
  const drawnOn = useRef(null);
  const engineRef = useRef(null);
  engineRef.current = engine;

  const stage = useRef(null);
  const canvas = useRef(null);
  const player = useRef(null);
  const repaint = useRef(null);
  const cache = useRef(null);
  if (cache.current === null) {
    cache.current = createTileCache();
  }

  const videoFormat = formatById(formatId);
  const mode3d = view === '3d' && engine !== null;
  const framing = framingById(framingId).factor;
  const boatSize = boatSizeById(boatSizeId).factor;
  const layers = useMemo(
    () => (seamarks ? TILE_LAYERS : TILE_LAYERS.filter((layer) => layer.id !== 'seamarks')),
    [seamarks]
  );

  // The zoom is worked out from the format's own size, so the preview frames
  // exactly what the MP4 will: rebuild the legs when the format changes.
  const storyboard = useMemo(() => {
    if (!passages) {
      return null;
    }
    const legs = buildLegs(passages, { width: videoFormat.width, height: videoFormat.height });
    return legs.length > 0 ? buildStoryboard(legs) : null;
  }, [passages, videoFormat.width, videoFormat.height]);

  useEffect(() => {
    let current = true;
    get(`/entries/stats${rangeParams(from, to) ? `?${rangeParams(from, to)}` : ''}`)
      .then((next) => current && setSummary(next))
      .catch(() => current && setSummary(null));
    return () => {
      current = false;
    };
  }, [from, to]);

  const load = async () => {
    setError(null);
    setPassages(null);
    setLoading({ done: 0, total: 0 });
    try {
      const query = rangeParams(from, to);
      const entries = await fetchAll(`/entries${query ? `?${query}` : ''}`);
      setLoading({ done: 0, total: entries.length });
      let done = 0;
      const loaded = await mapWithLimit(entries, TRACK_CONCURRENCY, async (entry) => {
        const track = await get(`/entries/${entry.id}/track`);
        done += 1;
        setLoading({ done, total: entries.length });
        return { entry, points: trackPoints(track) };
      });
      setPassages(loaded);
      setUnits(0);
    } catch (failure) {
      setError(failure);
    } finally {
      setLoading(null);
    }
  };

  // Which tiles a frame needs, per layer. Used to draw the preview and, before
  // an export, to count what would have to be downloaded.
  const tilesFor = (at, renderScale = 1) => {
    const state = stateAt(storyboard, at);
    if (!state) {
      return {};
    }
    if (mode3d) {
      return framing3d(state, {
        aspect: videoFormat.width / videoFormat.height,
        height: videoFormat.height,
        frameHeight: videoFormat.height * renderScale,
        layers,
        factor: framing
      }).tiles;
    }
    const projection = createProjection({
      zoom: state.camera.zoom,
      bounds: { centreLat: state.camera.centre.lat, centreLon: state.camera.centre.lon }
    });
    const lists = {};
    for (const layer of layers) {
      lists[layer.id] = visibleTiles(projection, state.camera.centre, {
        width: videoFormat.width,
        height: videoFormat.height,
        renderScale,
        layerMaxZoom: layer.maxZoom
      }).tiles;
    }
    return lists;
  };

  // Start the map for this instant on its way, without waiting: the preview
  // paints the sea where a tile has not landed yet, as any slippy map does.
  const requestTiles = (at, signal, renderScale = 1) => {
    const lists = tilesFor(at, renderScale);
    for (const layer of layers) {
      cache.current.request(layer, lists[layer.id] ?? [], signal);
    }
  };

  // Wait for it. The export draws nothing until its map is there, so a slow
  // connection changes how long the render takes and not what it looks like.
  const loadTiles = async (at, signal, renderScale = 1) => {
    const lists = tilesFor(at, renderScale);
    for (const layer of layers) {
      await cache.current.load(layer, lists[layer.id] ?? [], undefined, signal);
    }
  };

  const renderScene = (context, at, size) => {
    const state = stateAt(storyboard, at);
    if (!state) {
      return;
    }
    const clock = `${format.shortDate(state.timeMs)} ${format.time(state.timeMs)}`;
    const scene = {
      state,
      legs: storyboard.legs,
      width: size.width,
      height: size.height,
      renderScale: size.renderScale,
      cache: cache.current,
      layers,
      at,
      framing,
      boatSize,
      overlay: {
        speedLabel: t('animation.speed'),
        speed: format.speed(state.sog) || '—',
        distanceLabel: t('animation.covered'),
        distance: format.distance(state.distance),
        clock,
        attribution: t('animation.attribution')
      }
    };
    if (mode3d) {
      try {
        if (context.canvas === canvas.current) {
          drawnOn.current = context.canvas;
        }
        engine.renderScene3d(context, scene, { onContextLost: () => leave3d('view3dLost') });
        return;
      } catch (failure) {
        // An export has to say so; the preview falls back to the map.
        if (size.purpose === 'export') {
          throw failure;
        }
        leave3d('view3dFailed', failure);
      }
    }
    drawFrame(context, scene);
  };

  // Back to the map, saying why. Called from inside a paint, so the state it
  // sets is only picked up by the next one.
  const leave3d = (key, failure) => {
    setNotice3d({ key, message: failure?.message ?? String(failure ?? '') });
    setView('map');
  };

  // Wherever a frame was drawn for an export, its 3D renderer holds a WebGL
  // context; let it go when the export is over.
  const releaseScene = (context) => engine?.releaseScene3d(context.canvas);

  // Drawn in the format's own coordinates and scaled down to the canvas, so
  // what is on screen and what is encoded are the same picture.
  const paint = (at) => {
    const element = canvas.current;
    if (!element || !storyboard) {
      return;
    }
    const scale = element.width / videoFormat.width;
    const context = element.getContext('2d');
    context.setTransform(scale, 0, 0, scale, 0, 0);
    requestTiles(at, undefined, scale);
    // And the map the boat is about to reach, so it is there when it gets
    // there. Consecutive frames share most of their tiles, so this costs little.
    const rate = player.current?.state().speed ?? speed;
    const ahead = Math.min(at + LOOK_AHEAD_UNITS * rate, storyboard.totalUnits);
    if (ahead > at) {
      requestTiles(ahead, undefined, scale);
    }
    renderScene(context, at, {
      width: videoFormat.width,
      height: videoFormat.height,
      renderScale: scale
    });
    context.setTransform(1, 0, 0, 1, 0, 0);

    clearTimeout(repaint.current);
    if (cache.current.pending > 0) {
      repaint.current = setTimeout(() => paint(at), TILE_REPAINT_MS);
    }
  };

  // `paint` closes over the current format and layers; keep the latest one
  // where the player's frame callback can reach it.
  const latestPaint = useRef(paint);
  latestPaint.current = paint;

  useEffect(() => {
    if (!storyboard) {
      player.current = null;
      return undefined;
    }
    const instance = createPlayer({
      totalUnits: storyboard.totalUnits,
      speed,
      onFrame: (at) => {
        setUnits(at);
        latestPaint.current(at);
      },
      onStateChange: (state) => setPlaying(state.playing)
    });
    player.current = instance;
    instance.seek(0);
    const wake = () => instance.resetClock();
    document.addEventListener('visibilitychange', wake);
    return () => {
      document.removeEventListener('visibilitychange', wake);
      clearTimeout(repaint.current);
      instance.destroy();
      player.current = null;
    };
    // Deliberately not keyed on the speed: it is pushed into the player below,
    // so changing it mid-playback does not rebuild anything or move the film.
  }, [storyboard]);

  useEffect(() => player.current?.setSpeed(speed), [speed]);

  // The 3D view brings its library the first time it is asked for, and then the
  // boat the crew left in this browser, if any.
  useEffect(() => {
    if (view !== '3d' || engine) {
      return undefined;
    }
    let current = true;
    (async () => {
      try {
        const loaded = await import('../animation/renderer3d.mjs');
        if (!current) {
          return;
        }
        setEngine(loaded);
        const stored = await loadBoat();
        if (stored && current) {
          try {
            await loaded.setCustomBoat(stored.buffer.slice(0));
            setBoat({ name: stored.name, problem: null });
          } catch {
            // A model that no longer parses is not worth keeping.
            await clearBoat();
          }
        }
      } catch (failure) {
        if (current) {
          leave3d('view3dFailed', failure);
        }
      }
    })();
    return () => {
      current = false;
    };
  }, [view]);

  useEffect(
    () => () => {
      if (drawnOn.current) {
        engineRef.current?.releaseScene3d(drawnOn.current);
      }
    },
    []
  );

  // What changes the picture without moving the film: repaint at the same place.
  useEffect(() => {
    latestPaint.current(player.current?.state().units ?? 0);
  }, [mode3d, framing, boatSize, boat.name]);

  // The canvas takes the format's shape, fits the window, and is never given
  // more device pixels than the export itself has — otherwise a tall 9:16
  // preview would both run off the screen and pull finer tiles than the video
  // will ever use.
  useEffect(() => {
    const element = stage.current;
    if (!element) {
      return undefined;
    }
    const resize = () => {
      const available = element.clientWidth;
      if (!available || !canvas.current) {
        return;
      }
      const maxHeight = Math.max(MIN_STAGE_HEIGHT, globalThis.innerHeight * STAGE_HEIGHT_SHARE);
      let cssWidth = available;
      let cssHeight = (cssWidth * videoFormat.height) / videoFormat.width;
      if (cssHeight > maxHeight) {
        cssHeight = maxHeight;
        cssWidth = (cssHeight * videoFormat.width) / videoFormat.height;
      }
      const ratio = Math.min(globalThis.devicePixelRatio ?? 1, 2, videoFormat.width / cssWidth);
      canvas.current.style.width = `${Math.round(cssWidth)}px`;
      canvas.current.style.height = `${Math.round(cssHeight)}px`;
      canvas.current.width = Math.round(cssWidth * ratio);
      canvas.current.height = Math.round(cssHeight * ratio);
      latestPaint.current(player.current?.state().units ?? 0);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    globalThis.addEventListener('resize', resize);
    return () => {
      observer.disconnect();
      globalThis.removeEventListener('resize', resize);
    };
  }, [videoFormat, storyboard, layers]);

  const fileName = `chiplog-${from || 'all'}_${to || 'all'}-${formatId}${view === '3d' ? '-3d' : ''}.mp4`;

  const chooseView = (next) => {
    setNotice3d(null);
    setView(next);
  };

  const chooseBoat = async (event) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file || !engine) {
      return;
    }
    if (file.size > MAX_MODEL_BYTES) {
      setBoat((previous) => ({
        ...previous,
        problem: { key: 'animation.boatTooBig', params: { size: MAX_MODEL_BYTES / 1024 / 1024 } }
      }));
      return;
    }
    try {
      const buffer = await file.arrayBuffer();
      await engine.setCustomBoat(buffer.slice(0));
      const kept = await saveBoat({ name: file.name, buffer });
      setBoat({ name: file.name, problem: kept ? null : { key: 'animation.boatNotSaved' } });
    } catch (failure) {
      setBoat((previous) => ({
        ...previous,
        problem: {
          key: 'animation.boatInvalid',
          params: { message: (failure?.message ?? String(failure)).slice(0, 120) }
        }
      }));
    }
  };

  const resetBoat = async () => {
    await engine?.setCustomBoat(null);
    await clearBoat();
    setBoat({ name: null, problem: null });
  };
  const state = storyboard ? stateAt(storyboard, units) : null;
  const clock = state ? `${format.shortDate(state.timeMs)} ${format.time(state.timeMs)}` : '';

  return html`
    <h1 class="page-title">${t('animation.title')}</h1>

    <section class="card">
      <p>${t('animation.intro')}</p>
      <${DateRangePicker}
        from=${from}
        to=${to}
        label=${t('range.period')}
        onChange=${(range) => {
          setFrom(range.from);
          setTo(range.to);
        }}
      />
      ${
        summary &&
        html`<p class="muted">
          ${t('animation.summary', {
            passages: summary.count,
            distance: format.distance(summary.distance),
            duration: format.duration(summary.duration)
          })}
        </p>`
      }
      <div class="actions">
        <button type="button" disabled=${loading !== null} onClick=${load}>
          ${t('animation.load')}
        </button>
      </div>
      ${
        loading &&
        html`<p class="muted">
          ${t('animation.loading', { done: loading.done, total: loading.total })}
        </p>`
      }
      ${error && html`<${ErrorNotice} error=${error} />`}
      ${passages && !storyboard && html`<p class="empty">${t('animation.empty')}</p>`}
    </section>

    ${
      storyboard &&
      html`
        <section class="card animation">
          <div class="animation-modes">
            <div class="animation-modes-group" role="group" aria-label=${t('animation.view')}>
              <span class="animation-modes-label">${t('animation.view')}</span>
              <button
                type="button"
                class="animation-mode"
                aria-pressed=${view === 'map'}
                onClick=${() => chooseView('map')}
              >
                ${t('animation.viewMap')}
              </button>
              <button
                type="button"
                class="animation-mode"
                aria-pressed=${view === '3d'}
                disabled=${!webgl}
                onClick=${() => chooseView('3d')}
              >
                ${t('animation.view3d')}
              </button>
            </div>
            ${
              view === '3d' &&
              html`<div class="animation-modes-group" role="group" aria-label=${t('animation.cameraDistance')}>
                <span class="animation-modes-label">${t('animation.cameraDistance')}</span>
                ${CAMERA_FRAMINGS.map(
                  (option) =>
                    html`<button
                      key=${option.id}
                      type="button"
                      class="animation-mode"
                      aria-pressed=${option.id === framingId}
                      onClick=${() => setFramingId(option.id)}
                    >
                      ${t(option.labelKey)}
                    </button>`
                )}
              </div>`
            }
            ${
              view === '3d' &&
              html`<div class="animation-modes-group" role="group" aria-label=${t('animation.boatSize')}>
                <span class="animation-modes-label">${t('animation.boatSize')}</span>
                ${BOAT_SIZES.map(
                  (option) =>
                    html`<button
                      key=${option.id}
                      type="button"
                      class="animation-mode"
                      aria-pressed=${option.id === boatSizeId}
                      onClick=${() => setBoatSizeId(option.id)}
                    >
                      ${t(option.labelKey)}
                    </button>`
                )}
              </div>`
            }
          </div>
          ${!webgl && html`<p class="muted">${t('animation.view3dUnavailable')}</p>`}
          ${view === '3d' && !engine && html`<p class="muted">${t('animation.view3dLoading')}</p>`}
          ${
            notice3d &&
            html`<p class="notice">${t(`animation.${notice3d.key}`, { message: notice3d.message })}</p>`
          }
          <div class="animation-stage" ref=${stage}>
            <canvas
              class="animation-canvas"
              ref=${canvas}
              role="img"
              aria-label=${t('animation.videoLabel')}
            ></canvas>
          </div>

          <div class="animation-controls">
            <button
              type="button"
              class="animation-play"
              onClick=${() => player.current?.toggle()}
            >
              ${playing ? t('animation.pause') : units >= storyboard.totalUnits ? t('animation.restart') : t('animation.play')}
            </button>
            <input
              type="range"
              class="animation-slider"
              min="0"
              max=${storyboard.totalUnits}
              step="0.01"
              value=${units}
              aria-label=${t('animation.timeline')}
              onInput=${(event) => {
                player.current?.pause();
                player.current?.seek(Number(event.currentTarget.value));
              }}
            />
            <span class="animation-clock">${clock}</span>
            <div class="animation-speeds" role="group" aria-label=${t('animation.playbackSpeed')}>
              ${SPEEDS.map(
                (option) =>
                  html`<button
                    key=${option}
                    type="button"
                    class="animation-speed"
                    aria-pressed=${option === speed}
                    onClick=${() => setSpeed(option)}
                  >
                    ${t('animation.speedOption', { factor: new Intl.NumberFormat(language).format(option) })}
                  </button>`
              )}
            </div>
          </div>

          <dl class="facts animation-facts">
            <div>
              <dt>${t('animation.speed')}</dt>
              <dd>${state ? format.speed(state.sog) : ''}</dd>
            </div>
            <div>
              <dt>${t('animation.covered')}</dt>
              <dd>${state ? format.distance(state.distance) : ''}</dd>
            </div>
            <div>
              <dt>${t('timeline.time')}</dt>
              <dd>${clock}</dd>
            </div>
          </dl>

          <label class="animation-seamarks">
            <input
              type="checkbox"
              checked=${seamarks}
              onChange=${(event) => setSeamarks(event.currentTarget.checked)}
            />
            ${t('animation.seamarks')}
          </label>
          ${
            view === '3d' &&
            html`<div class="animation-boat">
              <span class="animation-modes-label">${t('animation.boat')}</span>
              <span>${boat.name ? t('animation.boatCustom', { name: boat.name }) : t('animation.boatDefault')}</span>
              <input
                type="file"
                class="animation-boat-file"
                accept=".glb,model/gltf-binary"
                ref=${boatInput}
                tabindex="-1"
                aria-hidden="true"
                onChange=${chooseBoat}
              />
              <button type="button" disabled=${!engine} onClick=${() => boatInput.current?.click()}>
                ${t('animation.boatLoad')}
              </button>
              ${
                boat.name &&
                html`<button type="button" onClick=${resetBoat}>${t('animation.boatReset')}</button>`
              }
              <span class="muted">${t('animation.boatHint')}</span>
              ${boat.problem && html`<span class="notice">${t(boat.problem.key, boat.problem.params)}</span>`}
            </div>`
          }
          ${cache.current.offline && html`<p class="notice">${t('animation.offline')}</p>`}
        </section>

        <${AnimationExport}
          storyboard=${storyboard}
          formatId=${formatId}
          onFormatChange=${setFormatId}
          speed=${speed}
          videoFormat=${videoFormat}
          fileName=${fileName}
          renderScene=${renderScene}
          releaseScene=${releaseScene}
          loadTiles=${loadTiles}
          requestTiles=${requestTiles}
        />
      `
    }
  `;
}
