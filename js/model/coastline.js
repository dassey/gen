/**
 * Sea fill from `natural=coastline`.
 *
 * Ocean is the one water feature OSM does *not* map as a polygon. It is mapped
 * as an open way with, by convention, land on the left of the direction of
 * travel. Without this, every coastal city prints with a flat slab where the
 * sea should be — which is exactly the view most people want on the plate.
 *
 * The approach: join the ways into maximal chains, clip each chain to the plate
 * outline, close the pieces that genuinely cross the edge by walking round the
 * boundary, and keep the closure that has sea on the right *and* land outside.
 * Anything ambiguous is discarded rather than guessed at — a missing sea is a
 * disappointment, a sea covering the whole city is a ruined print.
 */

import { normalize, union, intersection, pointInRing, closeRing } from '../core/geom.js';

const TOUCH_EPS = 1e-6;

function segmentIntersect(p1, p2, p3, p4) {
  const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]);
  if (Math.abs(d) < 1e-12) return null;
  const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d;
  const u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { point: [p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])], t };
}

const samePoint = (a, b) =>
  Math.abs(a[0] - b[0]) < TOUCH_EPS && Math.abs(a[1] - b[1]) < TOUCH_EPS;

/**
 * Join coastline ways end-to-end into the longest chains possible.
 *
 * Crucially this never reverses a way. Direction *is* the data here — land on
 * the left — so a chain assembled by flipping segments to make the endpoints
 * meet would have the sea on both sides.
 */
export function joinChains(ways) {
  const pending = ways.filter((w) => w && w.length >= 2).map((w) => w.slice());
  const chains = [];

  while (pending.length) {
    let chain = pending.shift();
    let grew = true;
    let guard = 0;

    while (grew && guard++ < 10000) {
      grew = false;
      if (samePoint(chain[0], chain[chain.length - 1])) break;

      for (let i = 0; i < pending.length; i++) {
        if (samePoint(chain[chain.length - 1], pending[i][0])) {
          chain = chain.concat(pending[i].slice(1));
        } else if (samePoint(pending[i][pending[i].length - 1], chain[0])) {
          chain = pending[i].slice(0, -1).concat(chain);
        } else {
          continue;
        }
        pending.splice(i, 1);
        grew = true;
        break;
      }
    }
    chains.push(chain);
  }
  return chains;
}

/** Where a boundary point sits along the ring, as a single ordering key. */
function boundaryParam(pt, ring) {
  let best = { key: 0, dist: Infinity };
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((pt[0] - x1) * dx + (pt[1] - y1) * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(pt[0] - (x1 + t * dx), pt[1] - (y1 + t * dy));
    if (d < best.dist) best = { key: i + t, dist: d };
  }
  return best.key;
}

/**
 * Split a polyline into the pieces that fall inside the ring, recording
 * whether each end was created by a boundary crossing.
 *
 * That flag is the important part. OSM splits long coastlines at arbitrary
 * nodes, so a way can begin and end in open water in the middle of the plate;
 * closing such a piece against the boundary would sweep in the entire
 * shoreline and flood the model.
 */
function clipChainToRing(points, ring) {
  const pieces = [];
  let current = null;
  let startedAtCrossing = false;
  let inside = pointInRing(points[0], ring);
  if (inside) current = [points[0]];

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const bInside = pointInRing(b, ring);

    if (inside === bInside) {
      if (inside) current.push(b);
      continue;
    }

    let hit = null;
    for (let j = 0; j < ring.length - 1; j++) {
      const x = segmentIntersect(a, b, ring[j], ring[j + 1]);
      if (x && (!hit || x.t < hit.t)) hit = x;
    }
    const crossing = hit ? hit.point : bInside ? b : a;

    if (inside) {
      current.push(crossing);
      if (current.length >= 2) {
        pieces.push({ points: current, startedAtCrossing, endedAtCrossing: true });
      }
      current = null;
    } else {
      current = [crossing, b];
      startedAtCrossing = true;
    }
    inside = bInside;
  }

  if (current && current.length >= 2) {
    pieces.push({ points: current, startedAtCrossing, endedAtCrossing: false });
  }
  return pieces;
}

/**
 * Close an open chain by walking the plate boundary from its end back to its
 * start. Both directions give a valid ring; the caller picks between them.
 */
function closeAlongBoundary(chain, ring, direction) {
  const n = ring.length - 1; // ring is closed, so the last point repeats [0]
  const startKey = boundaryParam(chain[0], ring);
  const endKey = boundaryParam(chain[chain.length - 1], ring);
  const out = chain.slice();

  const span =
    direction > 0 ? (startKey - endKey + n) % n : (endKey - startKey + n) % n;

  let cursor = direction > 0 ? Math.ceil(endKey) : Math.floor(endKey);
  for (let step = 0; step <= n; step++) {
    const travelled =
      direction > 0 ? (cursor - endKey + n) % n : (endKey - cursor + n) % n;
    if (travelled > span) break;
    out.push(ring[((cursor % n) + n) % n]);
    cursor += direction;
  }

  return closeRing(out);
}

/** Probe points either side of the chain's midpoint: sea right, land left. */
function probes(chain, offset) {
  const mid = Math.max(1, Math.floor(chain.length / 2));
  const a = chain[mid - 1];
  const b = chain[mid];
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const cx = (a[0] + b[0]) / 2;
  const cy = (a[1] + b[1]) / 2;
  return {
    sea: [cx + (dy / len) * offset, cy - (dx / len) * offset],
    land: [cx - (dy / len) * offset, cy + (dx / len) * offset],
  };
}

/**
 * @param {Array<Array<[number, number]>>} ways coastline polylines, mm
 * @param {Array} shapeRing plate outline, mm
 * @param {number} probeOffset how far to step off the shoreline, mm
 * @returns {Array} sea multipolygon clipped to the plate
 */
export function seaFromCoastline(ways, shapeRing, probeOffset = 1.5) {
  if (!ways.length) return [];
  const shapeMp = [[shapeRing]];
  let sea = [];

  for (const chain of joinChains(ways)) {
    if (chain.length < 2) continue;

    // A closed loop is already a polygon: an island if land is inside, a lagoon
    // if sea is. The left/right rule decides without any boundary walking.
    if (samePoint(chain[0], chain[chain.length - 1])) {
      const ring = closeRing(chain);
      const { sea: seaProbe } = probes(chain, probeOffset);
      if (pointInRing(seaProbe, ring)) sea = union(sea, normalize([[ring]]));
      continue;
    }

    for (const piece of clipChainToRing(chain, shapeRing)) {
      // Only a piece that entered and left through the plate edge can be
      // closed against it. Anything else ends in open water mid-plate.
      if (!piece.startedAtCrossing || !piece.endedAtCrossing) continue;
      if (piece.points.length < 2) continue;

      const p = probes(piece.points, probeOffset);
      const candidates = [
        closeAlongBoundary(piece.points, shapeRing, 1),
        closeAlongBoundary(piece.points, shapeRing, -1),
      ].filter((r) => r.length >= 4);

      // Require both: sea side in, land side out. One test alone can be
      // satisfied by the wrong closure when the shoreline hugs the plate edge.
      const pick = candidates.find(
        (ring) => pointInRing(p.sea, ring) && !pointInRing(p.land, ring)
      );
      if (pick) sea = union(sea, normalize([[pick]]));
    }
  }

  return sea.length ? intersection(sea, shapeMp) : [];
}
