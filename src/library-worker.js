import { parentPort, workerData } from 'node:worker_threads';
import { listLibrary } from './library.js';
parentPort.postMessage(listLibrary(workerData.root, { compact: true }));
