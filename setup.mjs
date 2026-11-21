import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const directory = new URL('./.runtime/models/', import.meta.url);
const file = new URL('hand_landmarker.task', directory);
const temporary = new URL('hand_landmarker.download', directory);
const expectedSize = 7819105;
if (await stat(file).then(info => info.size === expectedSize, () => false)) {
  console.log('Hand landmark model is ready.');
} else {
  await mkdir(directory, { recursive: true });
  try {
    const response = await fetch('https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task', { signal: AbortSignal.timeout(120000) });
    if (!response.ok || !response.body) throw new Error(`Model download failed (${response.status}).`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
    if ((await stat(temporary)).size !== expectedSize) throw new Error('The model download is incomplete.');
    await rename(temporary, file);
    console.log('Hand landmark model downloaded.');
  } finally {
    await rm(temporary, { force: true });
  }
}
