export const bones = [
  [0,1], [1,2], [2,3], [3,4], [0,5], [5,6], [6,7], [7,8],
  [5,9], [9,10], [10,11], [11,12], [9,13], [13,14], [14,15], [15,16],
  [13,17], [0,17], [17,18], [18,19], [19,20]
];

export const distance = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
export const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const clamp = (v, low, high) => Math.max(low, Math.min(v, high));

export class PenDetector {
  previous = null;
  missed = 0;
  last = null;
  palette = [];
  angles = Array.from({ length: 60 }, (_, i) => [Math.cos(i * Math.PI / 60), Math.sin(i * Math.PI / 60)]);

  sampleAppearance({ data, width, height }, points) {
    this.palette = [0.08, 0.23, 0.42, 0.58, 0.77, 0.92].map(t => {
      const [x, y] = mix(...points, t).map(Math.round);
      const i = (clamp(y, 0, height - 1) * width + clamp(x, 0, width - 1)) * 4;
      return [data[i], data[i + 1], data[i + 2]];
    });
  }

  find({ data, width, height }, hand, guide, elapsed) {
    const gray = new Uint8Array(width * height);
    for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
      gray[i] = (data[j] * 77 + data[j + 1] * 150 + data[j + 2] * 29) >> 8;
    }
    const last = this.last;
    this.last = gray;
    if (guide) {
      this.sampleAppearance({ data, width, height }, guide);
      this.previous = { points: guide, confidence: 1, state: 'guided' };
      this.missed = 0;
      return this.previous;
    }
    const joints = hand?.joints;
    const prior = this.missed * elapsed < 0.22 ? this.previous : null;
    if (!joints && !prior) return null;
    const center = joints?.[9] ?? mix(...prior.points, 0.5);
    const span = Math.max(18, joints ? distance(joints[5], joints[17]) : distance(...prior.points) * 0.45);
    const radius = Math.min(Math.max(width, height) * 0.62, Math.max(50, span * 3.2));
    const roi = Math.ceil(radius);
    const bins = roi + 2;
    const stride = 2 * bins + 1;
    const accumulator = new Float32Array(60 * stride);
    const edges = [];
    const startX = Math.max(2, Math.floor(center[0] - radius));
    const endX = Math.min(width - 2, Math.ceil(center[0] + radius));
    const startY = Math.max(2, Math.floor(center[1] - radius));
    const endY = Math.min(height - 2, Math.ceil(center[1] + radius));
    for (let y = startY; y < endY; y += 2) {
      for (let x = startX; x < endX; x += 2) {
        const i = y * width + x;
        const gx = gray[i + 1] - gray[i - 1];
        const gy = gray[i + width] - gray[i - width];
        const strength = Math.hypot(gx, gy);
        if (strength < 20) continue;
        const ox = x - center[0], oy = y - center[1];
        if (ox * ox + oy * oy > radius * radius) continue;
        const motion = last ? Math.abs(gray[i] - last[i]) : 12;
        const chroma = data[i * 4] - (data[i * 4 + 1] + data[i * 4 + 2]) * 0.5;
        const weight = Math.min(2.4, strength / 44) * (0.45 + Math.min(1.5, motion / 20)) * (chroma > 36 ? 0.75 : 1);
        const angle = Math.round(Math.atan2(gy, gx) * 60 / Math.PI);
        edges.push([ox, oy, weight, (angle + 120) % 60, motion]);
        for (let delta = -3; delta <= 3; delta++) {
          const k = (angle + delta + 120) % 60;
          const [nx, ny] = this.angles[k];
          const b = Math.round((nx * ox + ny * oy) / 2) + bins;
          accumulator[k * stride + b] += weight * (1 - Math.abs(delta) * 0.13);
        }
      }
    }
    const peaks = [];
    for (let k = 0; k < 60; k++) {
      for (let b = 1; b < stride - 1; b++) {
        const i = k * stride + b;
        const value = accumulator[i];
        const offset = (b - bins) * 2;
        if (value >= 9 && value >= accumulator[i - 1] && value >= accumulator[i + 1] && Math.abs(offset) < span * 1.65) {
          peaks.push({ k, offset, value });
        }
      }
    }
    peaks.sort((a, b) => b.value - a.value);
    let best = null;
    for (const { k, offset } of peaks.slice(0, 28)) {
      const [nx, ny] = this.angles[k];
      const lane = new Map();
      for (const [x, y, weight, angle, motion] of edges) {
        const difference = Math.abs(k - angle);
        if (Math.min(difference, 60 - difference) > 7 || Math.abs(nx * x + ny * y - offset) > 5) continue;
        const index = Math.floor((-ny * x + nx * y) / 4);
        const bin = lane.get(index) ?? [0, 0, 0];
        bin[0] += weight;
        bin[1] += (nx * x + ny * y) * weight;
        bin[2] += motion * weight;
        lane.set(index, bin);
      }
      const indices = [...lane.keys()].sort((a, b) => a - b);
      for (let start = 0, end; start < indices.length; start = end) {
        end = start + 1;
        while (end < indices.length && indices[end] - indices[end - 1] <= Math.max(3, Math.min(8, span / 9))) end++;
        const first = indices[start], lastIndex = indices[end - 1];
        const length = (lastIndex - first + 1) * 4;
        if (length < Math.max(18, span * 0.53) || length > span * 5.8 || end - start < 5) continue;
        let total = 0, cross = 0, moving = 0;
        for (let j = start; j < end; j++) {
          const bin = lane.get(indices[j]);
          total += bin[0]; cross += bin[1]; moving += bin[2];
        }
        const normal = cross / total;
        const location = t => [center[0] + nx * normal - ny * t, center[1] + ny * normal + nx * t];
        const points = [location(first * 4), location((lastIndex + 1) * 4)];
        const middle = mix(...points, 0.5);
        const contact = joints ? Math.min(...[4, 6, 7, 8, 10, 11, 12, 15, 16].map(id => {
          const point = joints[id];
          const t = clamp(((point[0] - points[0][0]) * -ny + (point[1] - points[0][1]) * nx) / length, 0, 1);
          return distance(point, mix(...points, t));
        })) : distance(middle, center);
        const density = (end - start) * 4 / length;
        const proximity = Math.exp(-contact / (span * 0.65));
        const movement = Math.min(1, moving / total / 35);
        const continuity = prior ? Math.exp(-distance(middle, mix(...prior.points, 0.5)) / Math.max(14, span * 1.2)) : 0.5;
        const extent = Math.min(length / (span * 1.65), 1.5);
        const color = this.palette.length ? [0.12, 0.27, 0.48, 0.69, 0.86].map(t => {
          const [x, y] = mix(...points, t).map(Math.round);
          const pixel = (clamp(y, 0, height - 1) * width + clamp(x, 0, width - 1)) * 4;
          const sample = [data[pixel], data[pixel + 1], data[pixel + 2]];
          return Math.exp(-Math.min(...this.palette.map(value => distance(sample, value))) / 35);
        }).reduce((sum, value) => sum + value / 5, 0) : 0.5;
        const score = density * extent * (0.22 + proximity) * (0.52 + movement * 0.48) * (0.65 + continuity * 0.35) * (0.62 + color * 0.76);
        if (score < 0.18 || best?.score >= score) continue;
        if (prior && distance(points[0], prior.points[1]) + distance(points[1], prior.points[0]) <
          distance(points[0], prior.points[0]) + distance(points[1], prior.points[1])) points.reverse();
        best = { points, score, confidence: clamp(0.25 + score * 0.46, 0.3, 0.9), state: 'observed' };
      }
    }
    if (best) {
      this.previous = best;
      this.missed = 0;
    } else {
      this.missed++;
    }
    return best;
  }
}

function interpolateTrack(frames, field, maxGap) {
  let left = -1;
  for (let right = 0; right < frames.length; right++) {
    if (!frames[right][field]) continue;
    const before = frames[left], after = frames[right];
    if (before && right - left > 1 && after.time - before.time <= maxGap) {
      for (let i = left + 1; i < right; i++) {
        const a = before[field], b = after[field];
        const t = (frames[i].time - before.time) / (after.time - before.time);
        const key = field === 'pen' ? 'points' : 'joints';
        frames[i][field] = { [key]: a[key].map((p, j) => mix(p, b[key][j], t)), confidence: Math.min(a.confidence, b.confidence) * 0.45, state: 'inferred' };
        if (a.world && b.world) frames[i][field].world = a.world.map((p, j) => mix(p, b.world[j], t));
      }
    }
    left = right;
  }
}

export function finishObservations(frames) {
  interpolateTrack(frames, 'hand', 0.23);
  interpolateTrack(frames, 'pen', 0.13);
}

export function monocular(clip) {
  const valid = clip.frames.filter(f => f.hand && f.pen && f.pen.state !== 'inferred');
  const lengthRatios = valid.map(({ hand, pen }) => distance(...pen.points) / Math.max(1, distance(hand.joints[5], hand.joints[17]))).sort((a, b) => a - b);
  const knownLength = lengthRatios[Math.floor(lengthRatios.length * 0.9)];
  const scales = clip.frames.filter(f => f.hand).map(f => distance(f.hand.joints[5], f.hand.joints[17])).filter(v => v > 2);
  const typical = median(scales) || clip.width / 5;
  let oldAxis = null;
  return clip.frames.map(({ time, hand, pen }) => {
    const world = hand?.world;
    const palm = world ? distance(world[5], world[17]) : 0;
    const toScene = ([x, y], depth = 0) => [(x - clip.width / 2) / typical, (clip.height / 2 - y) / typical, depth];
    const joints = hand?.joints.map((point, i) => toScene(point, palm ? -(world[i][2] - world[0][2]) / palm * 0.8 : 0));
    let points = null;
    if (pen && joints) {
      const projectedLength = distance(...pen.points) / typical;
      const target = Math.max(projectedLength, (knownLength || projectedLength) * distance(hand.joints[5], hand.joints[17]) / typical);
      const maxTilt = Math.sqrt(Math.max(0, target * target - projectedLength * projectedLength)) * 0.5;
      const fingers = [4, 6, 7, 8, 10, 11, 12, 14, 15, 16, 18, 19, 20];
      const nearest = pen.points.map(point => fingers.reduce((a, b) => distance(point, hand.joints[a]) < distance(point, hand.joints[b]) ? a : b));
      const depthA = joints[nearest[0]][2], depthB = joints[nearest[1]][2];
      const axis = depthB - depthA;
      const sign = Math.abs(axis) > 0.13 ? Math.sign(axis) : Math.sign(oldAxis || axis || 1);
      const positionalDepth = (depthA + depthB) / 2;
      oldAxis = sign;
      points = pen.points.map((point, i) => toScene(point, positionalDepth + (i ? 1 : -1) * sign * Math.min(1.15, maxTilt)));
    } else if (pen) {
      points = pen.points.map(point => toScene(point));
    }
    return { time, hand: joints ? { ...hand, joints } : null, pen: points ? { ...pen, points } : null };
  });
}

function solve(equations) {
  const a = Array.from({ length: 3 }, () => [0, 0, 0, 0]);
  for (const row of equations) {
    for (let i = 0; i < 3; i++) for (let j = 0; j < 4; j++) a[i][j] += row[i] * row[j];
  }
  for (let i = 0; i < 3; i++) {
    let pivot = i;
    for (let j = i + 1; j < 3; j++) if (Math.abs(a[j][i]) > Math.abs(a[pivot][i])) pivot = j;
    [a[i], a[pivot]] = [a[pivot], a[i]];
    const factor = a[i][i];
    if (Math.abs(factor) < 1e-10) return null;
    for (let j = i; j < 4; j++) a[i][j] /= factor;
    for (let j = 0; j < 3; j++) {
      if (j === i) continue;
      const coefficient = a[j][i];
      for (let k = i; k < 4; k++) a[j][k] -= coefficient * a[i][k];
    }
  }
  return a.map(row => row[3]);
}

const equation = (matrix, pixel) => pixel.map((value, i) =>
  matrix[i].map((v, j) => (v - value * matrix[2][j]) * (j === 3 ? -1 : 1)));
const triangulate = observations => solve(observations.flatMap(o => equation(o.matrix, o.pixel)));
function project(matrix, point) {
  const [x, y, z] = matrix.map(row => row[3] + point.reduce((sum, value, i) => sum + value * row[i], 0));
  return z > 1e-9 ? [x / z, y / z] : null;
}
const projectionError = (obs, point) => {
  const uv = project(obs.matrix, point);
  return uv ? distance(uv, obs.pixel) : Infinity;
};

export function validateCalibration(config, names) {
  const cameras = config?.cameras;
  if (!Array.isArray(cameras) || names.length < 2 || names.length !== cameras.length || new Set(names).size !== names.length) {
    throw new Error('Calibration needs one entry per uniquely named video, with at least two views.');
  }
  return names.map(name => {
    const camera = cameras.find(entry => entry?.file === name);
    const matrix = camera?.projection;
    if (!Array.isArray(matrix) || matrix.length !== 3 || !matrix.every(row => Array.isArray(row) && row.length === 4 && row.every(Number.isFinite)) ||
      (camera.offsetSeconds != null && !Number.isFinite(camera.offsetSeconds))) {
      throw new Error(`Invalid 3×4 projection or time offset for ${name}.`);
    }
    return { matrix, offset: camera.offsetSeconds ?? 0 };
  });
}

export function reconstructViews(clips, cameras, fps) {
  const start = Math.max(...cameras.map(camera => camera.offset));
  const end = Math.min(...cameras.map((camera, i) => camera.offset + clips[i].duration));
  if (end <= start) throw new Error('The videos have no common time after applying their offsets.');
  const frames = [];
  let previous = null, previousTime = -Infinity;
  for (let time = start; time < end; time += 1 / fps) {
    const views = clips.map((clip, index) => {
      const stamp = time - cameras[index].offset;
      const observation = clip.frames[Math.round(stamp * fps)];
      const px = ([x, y]) => [x * clip.sourceWidth / clip.width, y * clip.sourceHeight / clip.height];
      return { observation, px, matrix: cameras[index].matrix, tolerance: Math.max(6, clip.sourceWidth * 0.012) };
    }).filter(view => view.observation);
    const hands = views.filter(v => v.observation.hand?.state === 'observed');
    let hand = null, pen = null;
    if (hands.length >= 2) {
      const joints = Array.from({ length: 21 }, (_, joint) => {
        const observations = hands.map(v => ({ ...v, pixel: v.px(v.observation.hand.joints[joint]) }));
        let inliers = [];
        for (let i = 0; i < observations.length; i++) for (let j = i + 1; j < observations.length; j++) {
          const candidate = triangulate([observations[i], observations[j]]);
          if (!candidate) continue;
          const matching = observations.filter(v => projectionError(v, candidate) < v.tolerance);
          if (matching.length > inliers.length) inliers = matching;
        }
        return inliers.length >= 2 ? triangulate(inliers) : null;
      });
      if (joints.every(Boolean)) hand = { joints, state: 'observed', confidence: 0.9 };
    }
    const candidates = views.filter(v => v.observation.pen && v.observation.pen.state !== 'inferred')
      .map(v => ({ ...v, tips: v.observation.pen.points.map(v.px), guided: v.observation.pen.state === 'guided' }));
    let best = null;
    for (let a = 0; a < candidates.length; a++) for (let b = a + 1; b < candidates.length; b++) {
      for (const flip of candidates[a].guided && candidates[b].guided ? [0] : [0, 1]) {
        const first = candidates[a], second = candidates[b];
        const points = [0, 1].map(n => triangulate([
          { matrix: first.matrix, pixel: first.tips[n] },
          { matrix: second.matrix, pixel: second.tips[n ^ flip] }
        ]));
        if (points.some(p => !p)) continue;
        const matches = candidates.map(v => {
          const err = swap => points.reduce((sum, point, n) => sum + projectionError({ ...v, pixel: v.tips[n ^ swap] }, point), 0);
          const direct = err(0), reverse = v.guided && (first.guided || second.guided) ? Infinity : err(1);
          return { ...v, swap: Number(reverse < direct), error: Math.min(direct, reverse) };
        }).filter(v => v.error < v.tolerance * 2);
        if (matches.length < 2) continue;
        const score = matches.length - matches.reduce((sum, v) => sum + v.error / (2 * v.tolerance), 0) / matches.length;
        if (!best || score > best.score) best = { matches, score };
      }
    }
    if (best) {
      const points = [0, 1].map(n => triangulate(best.matches.map(v => ({ ...v, pixel: v.tips[n ^ v.swap] }))));
      if (points.every(Boolean)) {
        if (previous && time - previousTime < 0.15 && distance(points[0], previous[1]) + distance(points[1], previous[0]) <
          distance(points[0], previous[0]) + distance(points[1], previous[1])) points.reverse();
        previous = points;
        previousTime = time;
        pen = { points, state: best.matches.some(v => v.guided) ? 'guided' : 'observed',
          confidence: clamp(best.score / best.matches.length, 0.35, 0.98) };
      }
    }
    frames.push({ time: time - start, hand, pen });
  }
  finishObservations(frames);
  return { frames, duration: end - start, start };
}
