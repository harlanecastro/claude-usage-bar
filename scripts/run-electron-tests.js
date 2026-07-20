const { spawnSync } = require('child_process');
const path = require('path');
const electron = require('electron');

const result = spawnSync(electron, [
  '--test', path.join(__dirname, '..', 'test', 'consumption.test.js'),
], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});

process.exit(result.status ?? 1);
