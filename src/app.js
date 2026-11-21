import { analyze } from './vision.js';
import { bones, monocular, reconstructViews, validateCalibration } from './tracking.js';
import { demoSequence, MotionViewer, palmRelative } from './viewer.js';

const $ = id => document.getElementById(id);
const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const format = seconds => {
  const hundredths = Math.max(0, Math.floor((seconds || 0) * 100 + 0.000001));
  return `${Math.floor(hundredths / 6000)}:${String(Math.floor(hundredths / 100) % 60).padStart(2, '0')}.${String(hundredths % 100).padStart(2, '0')}`;
};
const viewer = new MotionViewer($('viewer'));
const preview = $('preview'), overlay = $('overlay');
const sources = [];
const demo = { name: 'Example animation', mode: 'demo', frames: demoSequence(), duration: 4, fps: 60 };
let active = null, selected = null, stereo = null, calibration = null, run = null;
let time = 0, playing = false, lastTick = 0, animationFrame = 0, draft = null;
let capture = null, recorder = null, recordStarted = 0, discarded = false, cameraRequest = 0;

function status(message, error = false) {
  $('status').textContent = message;
  $('status').dataset.error = error;
}

function setResult(result) {
  pause();
  active = result;
  $('result-name').textContent = result.name;
  $('mode').textContent = { demo: 'DEMO', single: 'SINGLE VIEW ESTIMATE', multi: 'CALIBRATED MULTI-VIEW' }[result.mode];
  $('export').disabled = result.mode === 'demo';
  $('time').max = result.duration;
  viewer.fit(result.frames);
  showTime(0);
}

function atTime(frames, sampleRate, stamp) {
  return frames[Math.max(0, Math.min(frames.length - 1, Math.round(stamp * sampleRate)))];
}

function showTime(stamp) {
  time = stamp;
  $('time').value = stamp;
  $('timecode').textContent = `${format(stamp)} / ${format(active.duration)}`;
  const frame = atTime(active.frames, active.fps, stamp);
  viewer.show(frame);
  $('quality').textContent = active.mode === 'demo' ? 'Example motion' :
    (!frame?.hand && !frame?.pen) ? 'No tracking at this time' :
      !frame?.pen ? 'Pen unavailable' :
        frame.pen.state === 'guided' ? 'Pen guided by marked tips' :
          frame.pen.state === 'inferred' ? 'Pen interpolated' :
            frame.pen.confidence < 0.55 ? 'Weak pen detection' : 'Pen estimate';
  if (selected && !draft && preview.readyState >= 1) {
    const viewTime = active.source === selected ? stamp :
      active.mode === 'multi' ? stamp + active.start - active.cameras.get(selected) : NaN;
    if (Number.isFinite(viewTime) && Math.abs(preview.currentTime - viewTime) > (playing ? 0.105 : 0.006)) {
      preview.currentTime = Math.max(0, Math.min(viewTime, Number.isFinite(preview.duration) ? preview.duration : viewTime));
    }
  }
}

function tick(now) {
  const next = Math.min(active.duration, time + (now - lastTick) / 1000 * Number($('speed').value));
  lastTick = now;
  showTime(next);
  if (next >= active.duration) pause();
  else if (playing) animationFrame = requestAnimationFrame(tick);
}
function pause() {
  playing = false;
  cancelAnimationFrame(animationFrame);
  $('play').innerHTML = icon('play');
  $('play').setAttribute('aria-label', 'Play animation');
  preview.pause();
}
function togglePlay() {
  if (playing) return pause();
  if (draft) stopMark();
  if (time >= active.duration) showTime(0);
  playing = true;
  $('play').innerHTML = icon('pause');
  $('play').setAttribute('aria-label', 'Pause animation');
  if (active.source === selected || active.cameras?.has(selected)) {
    preview.playbackRate = Number($('speed').value);
    preview.play().catch(() => {});
  }
  lastTick = performance.now();
  animationFrame = requestAnimationFrame(tick);
}
$('play').addEventListener('click', togglePlay);
$('time').addEventListener('input', () => { pause(); showTime(Number($('time').value)); });
$('speed').addEventListener('change', () => { preview.playbackRate = Number($('speed').value); });
$('grid').addEventListener('click', () => {
  viewer.grid = !viewer.grid;
  $('grid').setAttribute('aria-pressed', String(viewer.grid));
  viewer.draw();
});
$('reset').addEventListener('click', () => viewer.reset());

function row(name, use, label, onSelect, onSide, isActive) {
  const wrapper = document.createElement('div');
  wrapper.className = `clip-row${isActive ? ' active' : ''}`;
  const main = document.createElement('button');
  main.className = 'clip-main';
  main.innerHTML = icon('film');
  const title = document.createElement('span');
  title.textContent = name;
  main.append(title);
  main.title = name;
  if (isActive) main.setAttribute('aria-current', 'true');
  main.addEventListener('click', onSelect);
  const side = document.createElement('button');
  side.className = 'icon-button small-icon';
  side.innerHTML = icon(use);
  side.title = label;
  side.setAttribute('aria-label', `${label} ${name}`);
  side.addEventListener('click', onSide);
  wrapper.append(main, side);
  return wrapper;
}

function renderSources() {
  $('count').textContent = `${sources.length} ${sources.length === 1 ? 'clip' : 'clips'}`;
  $('process').disabled = !sources.length || !!run;
  $('drop').disabled = $('webcam').disabled = $('fps').disabled = $('calibrate').disabled = !!run;
  const list = $('clip-list');
  list.replaceChildren(...sources.map(source => row(source.name, 'x', 'Remove', () => selectSource(source), () => removeSource(source), selected === source)));
  list.querySelectorAll('.small-icon').forEach(button => { button.disabled = !!run; });
  $('library-list').querySelectorAll('button').forEach(button => { button.disabled = !!run; });
  $('guide').disabled = !!run;
  $('clear-guides').disabled = !!run;
  $('calibration-name').querySelector('button')?.toggleAttribute('disabled', !!run);
}

function selectSource(source, changeResult = true) {
  pause();
  selected = source;
  stopMark();
  $('source-preview').hidden = !source;
  if (source) {
    if (preview.getAttribute('src') !== source.url) preview.src = source.url;
    preview.playbackRate = Number($('speed').value);
    $('preview-name').textContent = source.name;
    if (changeResult && stereo && active !== stereo) setResult(stereo);
    if (changeResult && !stereo) setResult(source.result || demo);
  } else {
    preview.removeAttribute('src');
    preview.load();
    if (changeResult) setResult(demo);
  }
  renderSources();
  drawOverlay();
}

function addSource(source) {
  if (run) return;
  const existing = sources.find(clip => clip.url === source.url);
  if (existing) return selectSource(existing);
  if (stereo) stereo = null;
  source.guides = [];
  sources.push(source);
  selectSource(source);
  status('Ready to reconstruct.');
}

function removeSource(source) {
  if (run) return;
  const wasStereo = !!stereo;
  stereo = null;
  sources.splice(sources.indexOf(source), 1);
  if (selected === source || wasStereo) selectSource(selected === source ? sources[0] : selected);
  if (source.url.startsWith('blob:')) URL.revokeObjectURL(source.url);
  renderSources();
  status(sources.length ? 'Ready to reconstruct.' : 'Add a clip to start.');
}

function addFiles(files) {
  if (run) return;
  const videos = [...files].filter(file => file.type.startsWith('video/') || /\.(mp4|mov|webm|m4v|avi|mkv)$/i.test(file.name));
  videos.forEach(file => addSource({ name: file.name, url: URL.createObjectURL(file) }));
  if (!videos.length && files.length) status('Choose a video file such as MP4 or WebM.', true);
}
$('drop').addEventListener('click', () => $('files').click());
$('files').addEventListener('change', event => { addFiles(event.target.files); event.target.value = ''; });
$('drop').addEventListener('dragover', event => {
  event.preventDefault();
  if (!run) $('drop').classList.add('drag-over');
});
$('drop').addEventListener('dragleave', () => $('drop').classList.remove('drag-over'));
$('drop').addEventListener('drop', event => {
  event.preventDefault();
  $('drop').classList.remove('drag-over');
  addFiles(event.dataTransfer.files);
});
fetch('/api/clips').then(response => response.json()).then(names => {
  $('library').hidden = !names.length;
  $('library-count').textContent = names.length;
  $('library-list').replaceChildren(...names.map(name => {
    const add = () => addSource({ name, url: `/clips/${encodeURIComponent(name)}` });
    return row(name, 'add', 'Add', add, add, false);
  }));
  renderSources();
}).catch(() => {});

function download(data, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = Object.assign(document.createElement('a'), { href: url, download: name });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function setCalibration(value) {
  calibration = value;
  $('calibration-name').replaceChildren();
  if (!value) return;
  const text = document.createElement('span');
  text.textContent = value.name;
  const clear = document.createElement('button');
  clear.className = 'icon-button small-icon';
  clear.innerHTML = icon('x');
  clear.setAttribute('aria-label', 'Clear calibration');
  clear.addEventListener('click', () => setCalibration(null));
  $('calibration-name').append(text, clear);
}
$('calibrate').addEventListener('click', () => $('calibration-file').click());
$('calibration-file').addEventListener('change', async event => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file || run) return;
  try {
    const data = JSON.parse(await file.text());
    if (!run) setCalibration({ data, name: file.name });
  } catch {
    status('The calibration file could not be read as JSON.', true);
  }
});
$('calibration-example').addEventListener('click', event => {
  event.preventDefault();
  download({ cameras: [
    { file: 'camera-left.mp4', offsetSeconds: 0, projection: [[1000, 0, 640, 0], [0, 1000, 360, 0], [0, 0, 1, 0]] },
    { file: 'camera-right.mp4', offsetSeconds: 0, projection: [[1000, 0, 640, -180], [0, 1000, 360, 0], [0, 0, 1, 0]] }
  ] }, 'spinframe-calibration.example.json');
});

$('process').addEventListener('click', async () => {
  if (run || !sources.length) return;
  const inputs = [...sources], fps = Number($('fps').value);
  let cameras;
  try {
    if (calibration) cameras = validateCalibration(calibration.data, inputs.map(source => source.name));
  } catch (error) {
    return status(error.message, true);
  }
  pause();
  stopMark();
  const controller = new AbortController();
  run = controller;
  renderSources();
  $('progress-wrap').hidden = false;
  $('progress').value = 0;
  $('cancel').disabled = false;
  status('Loading the hand tracking model…');
  const failed = [];
  const successful = [];
  const started = performance.now();
  try {
    for (const [index, source] of inputs.entries()) {
      try {
        const signature = JSON.stringify([fps, source.guides]);
        if (source.signature === signature) {
          successful.push(source);
          $('progress').value = (index + 1) / inputs.length;
          continue;
        }
        const raw = await analyze(source, fps, controller.signal, progress => {
          $('progress').value = (index + progress) / inputs.length;
          status(`Analyzing clip ${index + 1} of ${inputs.length} · ${Math.round(progress * 100)}%`);
        });
        const frames = monocular(raw);
        if (!frames.some(frame => frame.hand || frame.pen)) throw new Error('No hand or pen was detected in this clip.');
        source.raw = raw;
        source.result = { name: source.name, mode: 'single', source, duration: raw.duration, frames, fps };
        source.signature = signature;
        successful.push(source);
      } catch (error) {
        controller.signal.throwIfAborted();
        failed.push({ name: source.name, message: error.message });
      }
    }
    controller.signal.throwIfAborted();
    if (cameras && successful.length === inputs.length) {
      const reconstructed = reconstructViews(inputs.map(source => source.raw), cameras, fps);
      if (!reconstructed.frames.some(frame => frame.hand || frame.pen)) {
        throw new Error('No points triangulated. Check camera calibration, synchronization, and tip marks.');
      }
      const map = new Map(inputs.map((source, index) => [source, cameras[index].offset]));
      stereo = { ...reconstructed, name: `${inputs.length} synchronized views`, mode: 'multi', fps, cameras: map };
      setResult(stereo);
    } else {
      stereo = null;
      if (successful.length) selectSource(successful.includes(selected) ? selected : successful[0]);
    }
    if (failed.length) {
      const prefix = successful.length ? `${successful.length} of ${inputs.length} clips finished. ` : '';
      status(`${prefix}${failed[0].name} · ${failed[0].message}`, true);
    } else {
      const tracked = active.frames.filter(frame => frame.pen && frame.pen.state !== 'inferred').length;
      status(`Finished in ${Math.round((performance.now() - started) / 1000)} s · Pen measurements in ${Math.round(100 * tracked / active.frames.length)}% of samples.`);
    }
  } catch (error) {
    stereo = null;
    if (successful.length) selectSource(successful.includes(selected) ? selected : successful[0]);
    status(controller.signal.aborted ? 'Analysis canceled.' : error.message, !controller.signal.aborted);
  } finally {
    run = null;
    $('progress-wrap').hidden = true;
    renderSources();
    drawOverlay();
  }
});
$('cancel').addEventListener('click', () => {
  run?.abort();
  $('cancel').disabled = true;
  status('Canceling analysis…');
});

function previewBounds() {
  const width = overlay.clientWidth, height = overlay.clientHeight;
  const scale = Math.min(width / preview.videoWidth, height / preview.videoHeight);
  const w = preview.videoWidth * scale, h = preview.videoHeight * scale;
  return { width, height, x: (width - w) / 2, y: (height - h) / 2, w, h };
}
function drawOverlay() {
  if (!selected || !preview.videoWidth || $('source-preview').hidden) return;
  const { width, height, x, y, w, h } = previewBounds();
  const dpi = Math.min(window.devicePixelRatio || 1, 2);
  if (overlay.width !== Math.round(width * dpi) || overlay.height !== Math.round(height * dpi)) {
    overlay.width = Math.round(width * dpi); overlay.height = Math.round(height * dpi);
  }
  const ctx = overlay.getContext('2d');
  ctx.setTransform(dpi, 0, 0, dpi, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const toCanvas = ([px, py]) => [x + px*w, y + py*h];
  const raw = selected.raw;
  const frame = raw && atTime(raw.frames, selected.result.fps, preview.currentTime);
  const guide = selected.guides.find(entry => Math.abs(entry.time - preview.currentTime) < 0.018);
  const points = (draft?.points || guide?.points || frame?.pen?.points.map(([px,py]) => [px/raw.width, py/raw.height]))?.map(toCanvas);
  if (frame?.hand && !draft) {
    const joints = frame.hand.joints.map(([px, py]) => toCanvas([px/raw.width, py/raw.height]));
    ctx.strokeStyle = '#7f9cffb0'; ctx.lineWidth = 2.2;
    for (const [from,to] of bones) {
      ctx.beginPath(); ctx.moveTo(...joints[from]); ctx.lineTo(...joints[to]); ctx.stroke();
    }
  }
  if (points?.length) {
    ctx.strokeStyle = '#ff995d'; ctx.fillStyle = '#ffe6c5'; ctx.lineWidth = 3;
    if (points.length > 1) {
      ctx.beginPath(); ctx.moveTo(...points[0]); ctx.lineTo(...points[1]); ctx.stroke();
    }
    for (const [px, py] of points) {
      ctx.beginPath(); ctx.arc(px, py, 5, 0, 2*Math.PI); ctx.fill(); ctx.stroke();
    }
  }
}
new ResizeObserver(drawOverlay).observe(overlay);
function updatePreview() {
  const duration = selected?.duration || preview.duration;
  $('source-time').max = Number.isFinite(duration) ? duration : 0;
  $('source-time').value = preview.currentTime;
  $('source-timecode').textContent = format(preview.currentTime);
  drawOverlay();
}
for (const event of ['loadeddata', 'durationchange', 'timeupdate', 'seeked']) preview.addEventListener(event, updatePreview);
preview.addEventListener('play', () => {
  $('source-play').innerHTML = icon('pause');
  $('source-play').setAttribute('aria-label', 'Pause source video');
});
preview.addEventListener('pause', () => {
  $('source-play').innerHTML = icon('play');
  $('source-play').setAttribute('aria-label', 'Play source video');
});
preview.addEventListener('error', () => {
  if (selected) $('guide-status').textContent = 'Preview unavailable. Try an H.264 MP4 or WebM file.';
});
$('source-time').addEventListener('input', () => {
  pause(); stopMark();
  if (preview.readyState) preview.currentTime = Number($('source-time').value);
});
$('source-play').addEventListener('click', () => {
  if (!preview.paused) return pause();
  pause(); stopMark();
  preview.play().catch(() => {});
});
function stopMark() {
  draft = null;
  overlay.classList.remove('marking');
  $('guide').innerHTML = `${icon('pen')} Mark pen tips`;
  const count = selected?.guides.length || 0;
  $('clear-guides').hidden = !count;
  $('guide-status').textContent = count ? `${count} marked ${count === 1 ? 'frame' : 'frames'}. Reconstruct motion to apply the marks.` :
    'Mark two visible tips on a sharp frame to help the pen tracker.';
  drawOverlay();
}
$('guide').addEventListener('click', () => {
  if (run || !preview.videoWidth) return;
  if (draft) return stopMark();
  pause();
  draft = { time: preview.currentTime, points: [] };
  overlay.classList.add('marking');
  $('guide').innerHTML = `${icon('x')} Cancel marking`;
  $('guide-status').textContent = 'Click the first visible tip, then the other tip.';
  drawOverlay();
});
overlay.addEventListener('pointerdown', event => {
  if (!draft) return;
  const rect = overlay.getBoundingClientRect(), {x,y,w,h} = previewBounds();
  const px = (event.clientX - rect.left - x) / w, py = (event.clientY - rect.top - y) / h;
  if (px < 0 || px > 1 || py < 0 || py > 1) return;
  draft.points.push([px, py]);
  if (draft.points.length === 1) {
    $('guide-status').textContent = 'Now click the other tip.';
    drawOverlay();
  } else {
    selected.guides = selected.guides.filter(guide => Math.abs(guide.time - draft.time) >= 0.018);
    selected.guides.push(draft);
    stopMark();
  }
});
$('clear-guides').addEventListener('click', () => { selected.guides = []; stopMark(); });

function recordStatus(message, error = false) {
  $('record-status').textContent = message;
  $('record-status').dataset.error = error;
}
function releaseCamera() {
  capture?.getTracks().forEach(track => track.stop());
  capture = null;
  $('camera').srcObject = null;
}
$('webcam').addEventListener('click', async () => {
  pause();
  const request = ++cameraRequest;
  discarded = false;
  $('record').disabled = true;
  $('record').innerHTML = '<span class="record-dot"></span> Start recording';
  recordStatus('Requesting camera access…');
  $('record-dialog').showModal();
  try {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error('Webcam recording requires localhost and a browser with MediaRecorder support.');
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } }, audio: false });
    if (request !== cameraRequest || !$('record-dialog').open) return stream.getTracks().forEach(track => track.stop());
    capture = stream;
    $('camera').srcObject = stream;
    $('record').disabled = false;
    const actual = stream.getVideoTracks()[0]?.getSettings().frameRate;
    recordStatus(actual ? `Camera ready · ${Math.round(actual)} fps` : 'Camera ready');
  } catch (error) {
    if (request !== cameraRequest) return;
    const messages = {
      NotAllowedError: 'Camera access was denied. Allow it in your browser and try again.',
      NotFoundError: 'No webcam was found.',
      NotReadableError: 'The webcam may be in use by another app.'
    };
    recordStatus(messages[error.name] || error.message, true);
  }
});
$('close-record').addEventListener('click', () => $('record-dialog').close());
$('record-dialog').addEventListener('close', () => {
  cameraRequest++;
  if (recorder && recorder.state !== 'inactive') {
    discarded = true;
    recorder.stop();
  }
  releaseCamera();
});
$('record').addEventListener('click', () => {
  if (recorder?.state === 'recording') {
    $('record').disabled = true;
    recorder.stop();
    return;
  }
  try {
    const type = ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/mp4'].find(value => MediaRecorder.isTypeSupported(value));
    recorder = new MediaRecorder(capture, { ...(type ? { mimeType: type } : {}), videoBitsPerSecond: 9000000 });
    const session = recorder, chunks = [], request = cameraRequest;
    session.addEventListener('dataavailable', event => { if (event.data.size) chunks.push(event.data); });
    session.addEventListener('error', () => recordStatus('Recording failed. Close the recorder and try again.', true));
    session.addEventListener('stop', () => {
      if (request !== cameraRequest || discarded) return;
      const seconds = (performance.now() - recordStarted) / 1000;
      const type = session.mimeType || chunks[0]?.type || 'video/webm';
      const extension = type.includes('mp4') ? 'mp4' : 'webm';
      const blob = new Blob(chunks, { type });
      if (blob.size && seconds >= 0.25) {
        addSource({ name: `Webcam ${new Date().toISOString().slice(0,19).replace(/[:T]/g, '-')}.${extension}`, url: URL.createObjectURL(blob), duration: seconds });
        $('record-dialog').close();
      } else {
        $('record').disabled = false;
        $('record').innerHTML = '<span class="record-dot"></span> Start recording';
        recordStatus('Capture at least a quarter of a second.', true);
      }
    });
    recordStarted = performance.now();
    session.start();
    $('record').innerHTML = `${icon('stop')} Stop & use clip`;
    recordStatus('Recording webcam…');
  } catch (error) {
    recordStatus(error.message, true);
  }
});

$('export').addEventListener('click', () => {
  if (active.mode === 'demo') return;
  const frames = active.frames.map(({ time, hand, pen }) => ({
    timeSeconds: time,
    hand: hand ? { joints: hand.joints, state: hand.state, confidence: hand.confidence } : null,
    pen: pen ? { tips: pen.points, state: pen.state, confidence: pen.confidence } : null,
    penRelativeToPalm: palmRelative({ hand, pen })
  }));
  download({
    schema: 'spinframe-motion-v1', source: active.name, mode: active.mode, sampleRate: active.fps,
    units: active.mode === 'multi' ? 'calibration world units' : 'approximate palm widths',
    handConnections: bones, frames
  }, `${active.source ? active.source.name.replace(/\.[^.]*$/, '') : 'spinframe-multiview'}-motion.json`);
});

setResult(demo);
renderSources();
