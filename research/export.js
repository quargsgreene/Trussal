#!/usr/bin/env node
// Roll research session logs (JSONL, written by the latency sidecar) into
// CSV for pandas/notebooks.
//
//   node research/export.js session-logs/session-<uuid>.jsonl [out.csv]
//   node research/export.js session-logs/            # exports every session
//
// Each CSV row is one event; columns are the union of keys across the file
// (missing fields stay empty). Nested objects (research-event data, health
// actions) are JSON-encoded in their cell so nothing is lost.

import { readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

export function jsonlToRows(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* torn tail line */ }
  }
  return rows;
}

export function rowsToCsv(rows) {
  const columns = [];
  const seen = new Set();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) { seen.add(key); columns.push(key); }
    }
  }
  const cell = (v) => {
    if (v === undefined || v === null) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map(c => cell(row[c])).join(','));
  return lines.join('\n') + '\n';
}

export function exportFile(inPath, outPath) {
  const rows = jsonlToRows(readFileSync(inPath, 'utf8'));
  const out = outPath || inPath.replace(/\.jsonl$/, '') + '.csv';
  writeFileSync(out, rowsToCsv(rows));
  return { out, events: rows.length };
}

const isMain = process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]));
if (isMain) {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: node research/export.js <session.jsonl | log-dir> [out.csv]');
    process.exit(1);
  }
  if (statSync(target).isDirectory()) {
    for (const f of readdirSync(target).filter(f => f.endsWith('.jsonl'))) {
      const { out, events } = exportFile(join(target, f));
      console.log(`${f} → ${out} (${events} events)`);
    }
  } else {
    const { out, events } = exportFile(target, process.argv[3]);
    console.log(`${target} → ${out} (${events} events)`);
  }
}
