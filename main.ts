// The driver for our csv-reader-speed-01 entry: the harness runs `node /bot/main.ts` (node22). It reads every
// case from /input/cases.json (a JSON array of {id, input}), answers each one alone with run() from solve.js,
// and writes /output/answers.json: a JSON array of the answers, one per case and in the cases' order. Outside a
// container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output.
//
// Version 2: each answer is serialized with JSON.stringify the moment it is produced and written straight to
// the output file — measurably cheaper than one JSON.stringify over the whole answers array plus a join of
// the pieces, and byte-identical to it (JSON.stringify of an array is its elements' serializations joined
// with commas, and the file is those same bytes written in the same order). solve.js is pulled in with a
// static import, not the house driver's dynamic one: the dynamic import's machinery measurably costs time in
// a fresh process, and the flag below governs the garbage collector while run() executes, which is after it.

import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { run } from './solve.js';

// V8's incremental marking off, set before any case is answered so all of solve.js's work runs under it (the
// rules: the house baseline runs with --no-incremental-marking, and an entry may tune V8's flags too).
setFlagsFromString('--no-incremental-marking');

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
const fd = openSync(join(OUTPUT_DIR, 'answers.json'), 'w');
writeSync(fd, '[');
for (let i = 0; i < cases.length; i++) {
  if (i > 0) writeSync(fd, ',');
  writeSync(fd, JSON.stringify(run(cases[i]!.input)));
}
writeSync(fd, ']');
closeSync(fd);
