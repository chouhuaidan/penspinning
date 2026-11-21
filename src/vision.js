import { PenDetector, finishObservations } from './tracking.js';

let visionFiles;
async function createLandmarker() {
  const { FilesetResolver, HandLandmarker } = await import('/vendor/vision_bundle.mjs').catch(() => {
    throw new Error('MediaPipe is unavailable. Run npm install and npm run setup, then restart Spinframe.');
  });
  visionFiles ??= FilesetResolver.forVisionTasks('/vendor/wasm').catch(error => {
    visionFiles = undefined;
    throw error;
  });
  return HandLandmarker.createFromOptions(await visionFiles, {
    baseOptions: { modelAssetPath: '/models/hand_landmarker.task', delegate: 'CPU' },
    runningMode: 'VIDEO', numHands: 1,
    minHandDetectionConfidence: 0.38,
    minHandPresenceConfidence: 0.43,
    minTrackingConfidence: 0.44
  }).catch(() => { throw new Error('The hand model could not start. Run npm run setup and use a current Edge or Chrome browser.'); });
}

function event(target, type, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`The video timed out waiting for ${type}.`)), 12000);
    const success = () => finish();
    const failed = () => finish(new Error('This video could not be decoded. Try H.264 MP4 or WebM.'));
    const aborted = () => finish(signal.reason);
    function finish(error) {
      clearTimeout(timer);
      target.removeEventListener(type, success);
      target.removeEventListener('error', failed);
      signal.removeEventListener('abort', aborted);
      if (error) reject(error);
      else resolve();
    }
    target.addEventListener(type, success);
    target.addEventListener('error', failed);
    signal.addEventListener('abort', aborted);
    if (signal.aborted) aborted();
  });
}

async function seek(video, time, signal) {
  if (Math.abs(video.currentTime - time) <= 0.0005) return;
  const seeked = event(video, 'seeked', signal);
  video.currentTime = time;
  await seeked;
}

export async function analyze(source, fps, signal, onProgress) {
  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  let model;
  try {
    const loaded = event(video, 'loadeddata', signal);
    video.src = source.url;
    await loaded;
    if (!Number.isFinite(video.duration)) await seek(video, 1e8, signal);
    const duration = Number.isFinite(video.duration) ? video.duration : source.duration || video.currentTime;
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('This clip has no readable duration.');
    const sourceWidth = video.videoWidth, sourceHeight = video.videoHeight;
    const scale = Math.min(1, 640 / Math.max(sourceWidth, sourceHeight));
    const canvas = document.createElement('canvas');
    const width = canvas.width = Math.round(sourceWidth * scale);
    const height = canvas.height = Math.round(sourceHeight * scale);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    model = await createLandmarker();
    const detector = new PenDetector();
    const frames = [];
    let lastUiUpdate = -Infinity;
    const count = Math.ceil(duration * fps);
    const guides = new Map(source.guides.map(guide => [
      Math.min(count - 1, Math.round(guide.time * fps)),
      guide.points.map(([x, y]) => [x * width, y * height])
    ]));
    if (guides.size) {
      const first = Math.min(...guides.keys());
      await seek(video, first / fps, signal);
      ctx.drawImage(video, 0, 0, width, height);
      detector.sampleAppearance(ctx.getImageData(0, 0, width, height), guides.get(first));
    }
    for (let i = 0; i < count; i++) {
      signal.throwIfAborted();
      const time = i / fps;
      await seek(video, time, signal);
      ctx.drawImage(video, 0, 0, width, height);
      const result = model.detectForVideo(canvas, time * 1000);
      const landmark = result.landmarks[0];
      const hand = landmark ? {
        joints: landmark.map(({ x, y }) => [x * width, y * height]),
        world: result.worldLandmarks[0]?.map(({ x, y, z }) => [x, y, z]),
        confidence: 0.9, state: 'observed'
      } : null;
      const pen = detector.find(ctx.getImageData(0, 0, width, height), hand, guides.get(i), 1 / fps);
      frames.push({ time, hand, pen });
      if (performance.now() - lastUiUpdate >= 90 || i === count - 1) {
        lastUiUpdate = performance.now();
        onProgress((i + 1) / count);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    finishObservations(frames);
    return { frames, width, height, sourceWidth, sourceHeight, duration };
  } finally {
    model?.close();
    video.removeAttribute('src');
    video.load();
  }
}
