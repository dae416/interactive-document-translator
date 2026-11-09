// Runs one function of parse.js in its own thread; see inWorker() in book.js.
import { parentPort, workerData } from 'node:worker_threads';
import * as parse from './parse.js';

parentPort.postMessage(await parse[workerData.fn](...workerData.args));
