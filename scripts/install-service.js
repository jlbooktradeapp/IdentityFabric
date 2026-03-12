/**
 * Windows Service installer/uninstaller using node-windows.
 *
 * Usage:
 *   node scripts/install-service.js install
 *   node scripts/install-service.js uninstall
 *
 * Run as Administrator!
 */
const path = require('path');
const Service = require('node-windows').Service;

const svc = new Service({
  name: 'IdentityFabricWeb',
  description: 'Identity Fabric Web Application — User directory, reporting, and identity management.',
  script: path.join(__dirname, '..', 'src', 'server.js'),
  nodeOptions: [],
  env: [
    { name: 'NODE_ENV', value: 'production' },
    { name: 'PORT', value: '3000' },
  ],
  // Restart on failure
  wait: 2,
  grow: 0.5,
  maxRestarts: 10,
});

const action = process.argv[2];

svc.on('install', () => {
  console.log('Service installed successfully.');
  console.log('Starting service...');
  svc.start();
});

svc.on('start', () => {
  console.log('Service started.');
});

svc.on('uninstall', () => {
  console.log('Service uninstalled.');
});

svc.on('alreadyinstalled', () => {
  console.log('Service is already installed.');
});

svc.on('invalidinstallation', () => {
  console.log('Invalid installation detected.');
});

svc.on('error', (err) => {
  console.error('Service error:', err);
});

if (action === 'install') {
  console.log('Installing Identity Fabric Web as a Windows Service...');
  console.log(`Script: ${svc.script}`);
  svc.install();
} else if (action === 'uninstall') {
  console.log('Uninstalling Identity Fabric Web Service...');
  svc.uninstall();
} else {
  console.log('Usage: node install-service.js <install|uninstall>');
  console.log('  Run as Administrator!');
  process.exit(1);
}
