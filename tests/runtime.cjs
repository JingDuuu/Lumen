// Test fixtures run in temporary data directories and never start the model.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const candidates = process.platform === 'win32'
  ? [path.join(root, '.venv/Scripts/python.exe'), path.resolve(root, '../venv/Scripts/python.exe')]
  : [path.join(root, '.venv/bin/python')];
exports.python = process.env.LUMEN_PYTHON || candidates.find(p => fs.existsSync(p)) || 'python';
