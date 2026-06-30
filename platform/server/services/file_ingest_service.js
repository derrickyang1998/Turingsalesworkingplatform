const fs = require('fs');
const path = require('path');

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let quote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; continue; }
    if (ch === '"') { quote = !quote; continue; }
    if (ch === ',' && !quote) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function parseCsv(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter(function(line) { return line.trim(); });
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]).map(function(h) { return h.trim(); });
  return lines.slice(1).map(function(line) {
    const cells = parseCsvLine(line);
    const row = {};
    headers.forEach(function(header, index) { row[header || ('col_' + index)] = cells[index] || ''; });
    return row;
  });
}

function tableSummary(rows, maxRows) {
  const sample = (rows || []).slice(0, maxRows || 20);
  const columns = Array.from(new Set(sample.flatMap(function(row) { return Object.keys(row || {}); })));
  return [
    'Rows: ' + (rows || []).length,
    'Columns: ' + columns.join(', '),
    '',
    'Sample:',
    JSON.stringify(sample, null, 2)
  ].join('\n');
}

function parseJson(text) {
  const data = JSON.parse(text);
  if (Array.isArray(data)) return { rows: data, content: tableSummary(data), kind: 'table' };
  if (data && Array.isArray(data.rows)) return { rows: data.rows, content: tableSummary(data.rows), kind: 'table' };
  return { rows: [], content: JSON.stringify(data, null, 2), kind: 'json' };
}

async function parseXlsx(filePath) {
  let readXlsxFile;
  try {
    readXlsxFile = require('read-excel-file/node');
  } catch (e) {
    const err = new Error('XLSX parser not installed. Run npm install in platform/server or upload CSV/TXT/MD.');
    err.code = 'XLSX_NOT_INSTALLED';
    throw err;
  }
  const rawRows = await readXlsxFile(filePath);
  if (!rawRows || !rawRows.length) return { rows: [], content: 'Rows: 0', kind: 'table' };
  const headers = rawRows[0].map(function(value, index) { return String(value || ('col_' + index)).trim(); });
  const rows = rawRows.slice(1).map(function(cells) {
    const row = {};
    headers.forEach(function(header, index) { row[header || ('col_' + index)] = cells[index] === undefined || cells[index] === null ? '' : cells[index]; });
    return row;
  });
  return { rows: rows, content: tableSummary(rows, 15), kind: 'table' };
}

async function readUploadedFile(file) {
  if (!file || !file.path) throw new Error('File is required');
  const ext = path.extname(file.originalname || file.path).toLowerCase();
  if (ext === '.xlsx') return parseXlsx(file.path);
  if (ext === '.xls') {
    const err = new Error('Legacy XLS is not supported. Please upload XLSX, CSV, TXT, or MD.');
    err.code = 'UNSUPPORTED_FILE_TYPE';
    throw err;
  }
  const text = fs.readFileSync(file.path, 'utf8');
  if (ext === '.csv') {
    const rows = parseCsv(text);
    return { rows: rows, content: tableSummary(rows), kind: 'table' };
  }
  if (ext === '.json') return parseJson(text);
  return { rows: [], content: text, kind: 'document' };
}

module.exports = {
  readUploadedFile,
  parseCsv,
  tableSummary
};
