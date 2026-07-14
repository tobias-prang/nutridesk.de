// Baut die signierte Tauri-App und veroeffentlicht sie auf nutridesk.de (PTB + Stable).
// Aufruf: npm run release [--build]
// Voraussetzung: Signatur-Key als Env gesetzt (TAURI_SIGNING_PRIVATE_KEY[_PATH] + _PASSWORD).
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const conf = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'src-tauri', 'tauri.conf.json'), 'utf8')
);
const version = conf.version;
const bundle = path.join(__dirname, 'src-tauri', 'target', 'release', 'bundle', 'nsis');
const exe = `NutriDesk_${version}_x64-setup.exe`;
const exePath = path.join(bundle, exe);
const sigPath = exePath + '.sig';

function sh(cmd) {
  execSync(cmd, { stdio: 'inherit' });
}

if (process.argv.includes('--build') || !fs.existsSync(sigPath)) {
  console.log('Baue signierte Tauri-App …');
  sh('npx tauri build');
}
if (!fs.existsSync(exePath) || !fs.existsSync(sigPath)) {
  console.error('Fehlt: ' + exe + ' (+ .sig). Erst "npm run build" mit gesetztem Signatur-Key.');
  process.exit(1);
}

const signature = fs.readFileSync(sigPath, 'utf8').trim();
const manifest = (channel) =>
  JSON.stringify(
    {
      version,
      notes: `NutriDesk ${version}`,
      pub_date: new Date().toISOString(),
      platforms: {
        'windows-x86_64': {
          signature,
          url: `https://nutridesk.de/updates/${channel === 'ptb' ? 'ptb/' : ''}${exe}`,
        },
      },
    },
    null,
    2
  );

const tmp = path.join(os.tmpdir(), 'nd-manifest');
fs.mkdirSync(tmp, { recursive: true });
fs.writeFileSync(path.join(tmp, 'ptb.json'), manifest('ptb'));
fs.writeFileSync(path.join(tmp, 'stable.json'), manifest('stable'));

const remote = '/home/nutridesk.de/web/cdn/downloads';
console.log('Lade v' + version + ' hoch (PTB + Stable) …');
sh(`scp "${exePath}" vmd197921:${remote}/ptb/${exe}`);
sh(`ssh vmd197921 "cp -f ${remote}/ptb/${exe} ${remote}/${exe}"`);
sh(`scp "${path.join(tmp, 'ptb.json')}" vmd197921:${remote}/ptb/tauri.json`);
sh(`scp "${path.join(tmp, 'stable.json')}" vmd197921:${remote}/tauri.json`);
console.log('Fertig. PTB sofort aktiv; Stable liefert nach SEC-002-Freischaltung aus.');
