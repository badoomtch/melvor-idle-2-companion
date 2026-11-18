// The worker thread that makes plans (plan-maker.js), so the companion's server keeps answering the page
// while a plan takes a few seconds. It keeps its own game data, built once.
import { parentPort, workerData } from 'node:worker_threads';
import { createGameData } from '../engine/gamedata.js';
import { makePlan } from './plan-maker.js';

const gd = createGameData(workerData.data);
parentPort.on('message', ({ n, job }) => {
  try {
    parentPort.postMessage({ n, locked: makePlan(gd, job) });
  } catch (e) {
    parentPort.postMessage({ n, error: e.message });
  }
});
