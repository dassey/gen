/**
 * Reading OSM tags as printable dimensions.
 *
 * OSM height data is patchy and inconsistent: some cities have surveyed
 * heights, most have `building:levels`, plenty have nothing at all. The
 * fallback chain here is deliberately conservative — a plausible guess reads as
 * a city; a wild one reads as a bug.
 */

const METRES_PER_LEVEL = 3.2;

/** "25", "25 m", "82'", "25.5 metres" -> metres. */
function parseLength(value) {
  if (value == null) return null;
  const s = String(value).trim().toLowerCase();

  const feetInches = s.match(/^(\d+(?:\.\d+)?)\s*'\s*(?:(\d+(?:\.\d+)?)\s*")?$/);
  if (feetInches) {
    const ft = parseFloat(feetInches[1]);
    const inch = feetInches[2] ? parseFloat(feetInches[2]) : 0;
    return ft * 0.3048 + inch * 0.0254;
  }

  const m = s.match(/^(-?\d+(?:[.,]\d+)?)\s*(m|metre|metres|meter|meters|ft|feet)?$/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  return m[2] === 'ft' || m[2] === 'feet' ? n * 0.3048 : n;
}

/**
 * Typical heights by building class, in metres. Only consulted when the data
 * carries neither a height nor a level count.
 */
const DEFAULT_HEIGHTS = {
  skyscraper: 120,
  cathedral: 40,
  church: 20,
  chapel: 10,
  mosque: 18,
  temple: 18,
  synagogue: 18,
  hospital: 25,
  university: 20,
  college: 16,
  hotel: 30,
  apartments: 16,
  residential: 12,
  commercial: 15,
  office: 25,
  retail: 8,
  supermarket: 8,
  industrial: 10,
  warehouse: 10,
  school: 10,
  civic: 14,
  public: 14,
  train_station: 15,
  house: 6.5,
  detached: 6.5,
  semidetached_house: 6.5,
  terrace: 8,
  bungalow: 4,
  hut: 3,
  shed: 3,
  garage: 3,
  garages: 3,
  roof: 4,
  carport: 3,
  greenhouse: 4,
  service: 3,
  kiosk: 3,
};

/**
 * Real-world building height in metres.
 * @param {object} tags
 * @param {number} fallback default when nothing at all is tagged
 */
export function buildingHeight(tags, fallback = 9) {
  const explicit =
    parseLength(tags.height) ??
    parseLength(tags['building:height']) ??
    parseLength(tags['est_height']);
  if (explicit && explicit > 0) return explicit;

  const levels =
    parseFloat(tags['building:levels']) ||
    parseFloat(tags['levels']) ||
    null;
  if (levels && levels > 0) {
    const roof = parseFloat(tags['roof:levels']) || 0;
    return (levels + roof * 0.6) * METRES_PER_LEVEL + 1;
  }

  const kind = tags.building || tags['building:part'];
  if (kind && DEFAULT_HEIGHTS[kind]) return DEFAULT_HEIGHTS[kind];
  if (tags.amenity && DEFAULT_HEIGHTS[tags.amenity]) return DEFAULT_HEIGHTS[tags.amenity];

  return fallback;
}

/**
 * Road widths in metres, keyed by `highway`. These are carriageway widths
 * including shoulders — a printed street reads better slightly wide than
 * slightly thin.
 */
const ROAD_WIDTHS = {
  motorway: 22,
  motorway_link: 12,
  trunk: 18,
  trunk_link: 10,
  primary: 15,
  primary_link: 9,
  secondary: 13,
  secondary_link: 8,
  tertiary: 11,
  tertiary_link: 7,
  unclassified: 8,
  residential: 8,
  living_street: 7,
  pedestrian: 8,
  service: 5,
  track: 4,
  bus_guideway: 7,
  busway: 7,
  road: 8,
  footway: 2,
  path: 1.8,
  steps: 2,
  cycleway: 2.5,
  bridleway: 2,
  corridor: 2,
};

/** Broad classes drive both default visibility and optional colour splitting. */
export const ROAD_CLASSES = {
  motorway: 'major',
  motorway_link: 'major',
  trunk: 'major',
  trunk_link: 'major',
  primary: 'major',
  primary_link: 'major',
  secondary: 'major',
  secondary_link: 'major',
  tertiary: 'minor',
  tertiary_link: 'minor',
  unclassified: 'minor',
  residential: 'minor',
  living_street: 'minor',
  road: 'minor',
  service: 'service',
  track: 'service',
  busway: 'minor',
  bus_guideway: 'minor',
  pedestrian: 'path',
  footway: 'path',
  path: 'path',
  steps: 'path',
  cycleway: 'path',
  bridleway: 'path',
  corridor: 'path',
};

export function roadClass(tags) {
  return ROAD_CLASSES[tags.highway] || 'minor';
}

/**
 * Road width in metres, refined by lane count where it is tagged.
 * @returns {number|null} null for road types we deliberately never print
 */
export function roadWidth(tags) {
  const explicit = parseLength(tags.width);
  if (explicit && explicit > 0.5) return Math.min(explicit, 40);

  let base = ROAD_WIDTHS[tags.highway];
  if (base == null) return null;

  const lanes = parseFloat(tags.lanes);
  if (Number.isFinite(lanes) && lanes >= 1) {
    base = Math.max(base, lanes * 3.4 + 1);
  }
  if (tags.oneway === 'yes' && !Number.isFinite(lanes)) base *= 0.7;
  return base;
}

const RAIL_WIDTHS = {
  rail: 5,
  light_rail: 4.5,
  subway: 4.5,
  tram: 4,
  narrow_gauge: 3.5,
  monorail: 3.5,
};

export function railWidth(tags) {
  return RAIL_WIDTHS[tags.railway] || null;
}

/** Underground features have no business on the surface of a model. */
export function isUnderground(tags) {
  if (tags.tunnel && tags.tunnel !== 'no') return true;
  if (tags.location === 'underground') return true;
  if (tags.covered === 'yes' && tags.railway === 'subway') return true;
  const layer = parseFloat(tags.layer);
  return Number.isFinite(layer) && layer < 0;
}

export function isBridge(tags) {
  return Boolean(tags.bridge && tags.bridge !== 'no');
}

/** Water bodies tagged as tunnels/culverts are not visible surface water. */
export function isVisibleWater(tags) {
  if (tags.tunnel && tags.tunnel !== 'no') return false;
  if (tags.covered === 'yes') return false;
  if (tags.intermittent === 'yes') return false;
  return true;
}

/** Linear waterways get a width so streams and canals still read at scale. */
const WATERWAY_WIDTHS = { river: 30, canal: 15, stream: 4, ditch: 2, drain: 2 };

export function waterwayWidth(tags) {
  const explicit = parseLength(tags.width);
  if (explicit && explicit > 0.5) return Math.min(explicit, 400);
  return WATERWAY_WIDTHS[tags.waterway] || null;
}

/** A readable name for the nameplate, when the user has not typed one. */
export function featureName(tags) {
  return tags['name:en'] || tags.name || '';
}
