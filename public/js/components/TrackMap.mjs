import { html, useEffect, useRef } from '../../vendor/preact-htm.mjs';
import { useLocale } from '../context.mjs';

const TRACK_COLOUR = '#e8590c';
const DEPARTURE_COLOUR = '#2b8a3e';
const ARRIVAL_COLOUR = '#c92a2a';

// Signal K serves every page with `Referrer-Policy: no-referrer`, and the
// OpenStreetMap tile servers answer a request without a Referer with an
// "Access blocked" tile. Send the origin only, as browsers do by default.
const TILE_REFERRER_POLICY = 'strict-origin-when-cross-origin';

// Leaflet renders a string tooltip as HTML; place names are typed by the crew.
function textTooltip(text) {
  const element = document.createElement('span');
  element.textContent = text;
  return element;
}

export function TrackMap({ track, entry }) {
  const { t } = useLocale();
  const container = useRef(null);
  const map = useRef(null);
  const overlay = useRef(null);
  const fitted = useRef(false);

  useEffect(() => {
    const instance = L.map(container.current, { scrollWheelZoom: false });
    const streets = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      referrerPolicy: TILE_REFERRER_POLICY,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(instance);
    const seamarks = L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
      maxZoom: 18,
      referrerPolicy: TILE_REFERRER_POLICY,
      attribution: '© <a href="https://www.openseamap.org">OpenSeaMap</a>'
    }).addTo(instance);
    L.control.layers({ OpenStreetMap: streets }, { [t('map.seamarks')]: seamarks }).addTo(instance);
    map.current = instance;
    return () => {
      instance.remove();
      map.current = null;
    };
  }, []);

  // Redrawn on each refresh of a passage in progress, without resetting the
  // view the reader may have zoomed to.
  useEffect(() => {
    const instance = map.current;
    overlay.current?.remove();
    const group = L.featureGroup();

    if (track?.geometry) {
      L.geoJSON(track, { style: { color: TRACK_COLOUR, weight: 3, opacity: 0.9 } }).addTo(group);
    }
    const ends = [[entry.startPosition, entry.startPlaceName, DEPARTURE_COLOUR]];
    if (entry.endTime) {
      ends.push([entry.endPosition, entry.endPlaceName, ARRIVAL_COLOUR]);
    }
    for (const [position, name, colour] of ends) {
      if (position) {
        L.circleMarker([position.lat, position.lon], {
          radius: 7,
          color: '#ffffff',
          weight: 2,
          fillColor: colour,
          fillOpacity: 1
        })
          .bindTooltip(textTooltip(name ?? t('place.unknown')))
          .addTo(group);
      }
    }

    group.addTo(instance);
    overlay.current = group;
    const bounds = group.getBounds();
    if (!fitted.current && bounds.isValid()) {
      instance.fitBounds(bounds, { padding: [24, 24], maxZoom: 15 });
      fitted.current = true;
    }
  }, [track, entry]);

  return html`<div class="track-map" ref=${container}></div>`;
}
