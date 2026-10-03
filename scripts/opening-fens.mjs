#!/usr/bin/env node
// Prints {"<SAN moves joined with spaces>": "<FEN>", ...} for every named opening line.
// Used by scripts/opening-evals.py.
import { readFileSync, readdirSync } from 'node:fs';
import { Chess } from 'chess.js';

const dir = new URL('../src/data/openings/', import.meta.url).pathname;
const out = {};
for (const f of readdirSync(dir).filter((f) => f.endsWith('.tsv'))) {
  for (const line of readFileSync(dir + f, 'utf8').trim().split('\n').slice(1)) {
    const chess = new Chess();
    chess.loadPgn(line.split('\t')[2]);
    out[chess.history().join(' ')] = chess.fen();
  }
}
process.stdout.write(JSON.stringify(out));
