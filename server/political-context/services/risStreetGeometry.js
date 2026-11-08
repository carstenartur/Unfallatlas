'use strict';

function lines(street) {
  const { type, coordinates } = street.geometry;
  return type === 'LineString' ? [coordinates] : coordinates;
}

const same = (a, b) => a[0] === b[0] && a[1] === b[1];
const difference = (a, b) => [a[0] - b[0], a[1] - b[1]];
const length = ([x, y], latitude) => Math.hypot(x * Math.cos(latitude * Math.PI / 180), y);
const roundPosition = coordinates => coordinates.map(value => Math.round(value * 1e7) / 1e7);

function edges(paths) {
  return paths.flatMap(path => path.slice(1).map((end, i) => [path[i], end])).filter(([a, b]) => !same(a, b));
}

function streetJunction(first, second) {
  // The network has a shared vertex at a junction. A planar intersection of
  // the lines alone could also be an overpass.
  const vertices = new Set(lines(first).flat().map(point => point.join(',')));
  let junction = null;
  for (const point of lines(second).flat()) {
    if (!vertices.has(point.join(','))) continue;
    if (junction && !same(junction, point)) return null;
    junction = point;
  }
  return junction;
}

function anchorOnRoad(anchor, segments) {
  let closest = null;
  // A known junction or landmark can have a small coordinate rounding gap.
  // Do not snap a distant landmark to an unrelated part of the road.
  for (const [index, [a, b]] of segments.entries()) {
    const [dx, dy] = difference(b, a);
    const [ax, ay] = difference(anchor, a);
    const scale = Math.cos(anchor[1] * Math.PI / 180) ** 2;
    const t = Math.max(0, Math.min(1, (ax * dx * scale + ay * dy) / (dx * dx * scale + dy * dy)));
    const point = roundPosition([a[0] + t * dx, a[1] + t * dy]);
    const distance = length(difference(anchor, point), anchor[1]);
    if (distance <= 8 / 111_000 && (!closest || distance < closest.distance)) {
      closest = { index, t, point, distance };
    }
  }
  return closest;
}

function streetSection(street, from, to, approach = []) {
  const segments = edges([...lines(street), ...approach]);
  const start = anchorOnRoad(from, segments);
  const end = anchorOnRoad(to, segments);
  if (!start || !end || same(start.point, end.point)) return null;
  const graph = new Map();
  const positions = new Map();
  const connect = (a, b) => {
    if (same(a, b)) return;
    const first = a.join(',');
    const second = b.join(',');
    const weight = length(difference(a, b), from[1]);
    for (const [key, neighbor, point] of [[first, second, a], [second, first, b]]) {
      if (!graph.has(key)) graph.set(key, new Map());
      graph.get(key).set(neighbor, weight);
      positions.set(key, point);
    }
  };
  for (const [index, [a, b]] of segments.entries()) {
    const split = [start, end].filter(anchor => anchor.index === index).sort((x, y) => x.t - y.t);
    const points = [a, ...split.map(anchor => anchor.point), b];
    points.slice(1).forEach((point, i) => connect(points[i], point));
  }

  const source = start.point.join(',');
  const target = end.point.join(',');
  const distances = new Map([[source, 0]]);
  const previous = new Map();
  const pending = new Set([source]);
  while (pending.size) {
    let current;
    for (const key of pending) if (current === undefined || distances.get(key) < distances.get(current)) current = key;
    pending.delete(current);
    if (current === target) {
      const coordinates = [];
      for (let key = target; key !== undefined; key = previous.get(key)) coordinates.push(positions.get(key));
      return { type: 'LineString', coordinates: coordinates.reverse() };
    }
    for (const [next, weight] of graph.get(current) || []) {
      const distance = distances.get(current) + weight;
      if (distance >= (distances.get(next) ?? Infinity)) continue;
      distances.set(next, distance);
      previous.set(next, current);
      pending.add(next);
    }
  }
  return null;
}

module.exports = { streetJunction, streetSection };
