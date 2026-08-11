/**
 * Place lookup.
 *
 * Two services, each used for what it is actually good at:
 *   - Photon (komoot) powers the as-you-type suggestions. It is purpose-built
 *     for typeahead and explicitly tolerates the request rate that implies.
 *   - Nominatim handles committed lookups and reverse geocoding, where its
 *     richer address structuring is worth the 1 req/s ceiling.
 *
 * Both are free OSM services run on donated hardware. Requests are debounced,
 * throttled and cached so this tool stays a good citizen.
 */

const PHOTON = 'https://photon.komoot.io/api/';
const NOMINATIM = 'https://nominatim.openstreetmap.org';

const cache = new Map();
let lastNominatimCall = 0;

async function throttleNominatim() {
  const gap = Date.now() - lastNominatimCall;
  if (gap < 1100) await new Promise((r) => setTimeout(r, 1100 - gap));
  lastNominatimCall = Date.now();
}

/** "40.7128, -74.006" and friends — skip the network entirely. */
function parseLatLon(query) {
  const m = query
    .trim()
    .match(/^(-?\d{1,2}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lon = parseFloat(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return {
    lat,
    lon,
    label: `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
    detail: 'Coordinates',
    kind: 'coordinates',
  };
}

function photonLabel(props) {
  const main =
    props.name ||
    [props.housenumber, props.street].filter(Boolean).join(' ') ||
    props.postcode ||
    props.city ||
    'Unnamed place';
  const detail = [
    props.street && props.name ? props.street : null,
    props.district,
    props.city || props.county,
    props.state,
    props.country,
  ]
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i)
    .slice(0, 3)
    .join(', ');
  return { main, detail };
}

/**
 * Autocomplete suggestions.
 * @param {string} query
 * @param {object} [opts] `near` biases results towards {lat, lon}
 * @returns {Promise<Array<{lat, lon, label, detail, kind, bbox?}>>}
 */
export async function suggest(query, opts = {}) {
  const q = query.trim();
  if (q.length < 2) return [];

  const direct = parseLatLon(q);
  if (direct) return [direct];

  const key = `photon:${q}:${opts.near ? `${opts.near.lat.toFixed(2)},${opts.near.lon.toFixed(2)}` : ''}`;
  if (cache.has(key)) return cache.get(key);

  const url = new URL(PHOTON);
  url.searchParams.set('q', q);
  url.searchParams.set('limit', '8');
  if (opts.near) {
    url.searchParams.set('lat', String(opts.near.lat));
    url.searchParams.set('lon', String(opts.near.lon));
  }
  if (opts.signal?.aborted) return [];

  let results = [];
  try {
    const res = await fetch(url, { signal: opts.signal });
    if (!res.ok) throw new Error(`Photon ${res.status}`);
    const data = await res.json();
    results = (data.features || []).map((f) => {
      const { main, detail } = photonLabel(f.properties || {});
      const [lon, lat] = f.geometry.coordinates;
      return {
        lat,
        lon,
        label: main,
        detail,
        kind: f.properties?.osm_value || f.properties?.type || 'place',
        bbox: f.properties?.extent
          ? // Photon extent is [minLon, maxLat, maxLon, minLat]
            {
              minLon: f.properties.extent[0],
              maxLat: f.properties.extent[1],
              maxLon: f.properties.extent[2],
              minLat: f.properties.extent[3],
            }
          : null,
      };
    });
  } catch (err) {
    if (err.name === 'AbortError') return [];
    // Photon down: fall through to Nominatim so search still works.
    try {
      results = await searchNominatim(q, 8);
    } catch {
      results = [];
    }
  }

  cache.set(key, results);
  return results;
}

/** Structured lookup via Nominatim. Handles bare postcodes well. */
export async function searchNominatim(query, limit = 5) {
  const key = `nom:${query}:${limit}`;
  if (cache.has(key)) return cache.get(key);
  await throttleNominatim();

  const url = new URL(`${NOMINATIM}/search`);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('addressdetails', '1');

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  const data = await res.json();

  const out = data.map((d) => ({
    lat: parseFloat(d.lat),
    lon: parseFloat(d.lon),
    label: d.name || d.display_name.split(',')[0],
    detail: d.display_name.split(',').slice(1, 4).join(',').trim(),
    kind: d.type,
    bbox: d.boundingbox
      ? {
          minLat: parseFloat(d.boundingbox[0]),
          maxLat: parseFloat(d.boundingbox[1]),
          minLon: parseFloat(d.boundingbox[2]),
          maxLon: parseFloat(d.boundingbox[3]),
        }
      : null,
  }));
  cache.set(key, out);
  return out;
}

/** Coordinates -> a human-readable place name, for auto-filling the nameplate. */
export async function reverse(lat, lon) {
  const key = `rev:${lat.toFixed(4)},${lon.toFixed(4)}`;
  if (cache.has(key)) return cache.get(key);
  await throttleNominatim();

  const url = new URL(`${NOMINATIM}/reverse`);
  url.searchParams.set('lat', String(lat));
  url.searchParams.set('lon', String(lon));
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('zoom', '14');

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Nominatim ${res.status}`);
    const d = await res.json();
    const a = d.address || {};
    const out = {
      city: a.city || a.town || a.village || a.suburb || a.county || '',
      state: a.state || a.region || '',
      country: a.country || '',
      countryCode: (a.country_code || '').toUpperCase(),
      display: d.display_name || '',
    };
    cache.set(key, out);
    return out;
  } catch {
    return { city: '', state: '', country: '', countryCode: '', display: '' };
  }
}

/** Format coordinates the way a nameplate wants them. */
export function formatCoords(lat, lon) {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(4)}° ${ns}  ${Math.abs(lon).toFixed(4)}° ${ew}`;
}
