import { parentPort, workerData } from 'node:worker_threads';
import { parseFile } from './parser.js';
try {
  const facts = await parseFile(workerData.filePath, workerData.content, { maxSize: workerData.maxSize, inWorker: true });
  parentPort.postMessage({ facts });
} catch { parentPort.postMessage({ error: 'Parser failed' }); }
