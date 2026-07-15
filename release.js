// Baut/veroeffentlicht die signierte Tauri-App auf nutridesk.de (PTB + Stable).
// Unterstuetzt Windows (nsis) und macOS (aarch64). Veroeffentlicht werden NUR die
// Plattformen, deren signierte Artefakte lokal vorhanden sind (also vorher bauen):
//   Windows: npm run build       (erzeugt nsis .exe + .sig)
//   macOS:   npm run build:mac   (erzeugt .app.tar.gz + .sig)
// Aufruf danach: npm run release
// Voraussetzung: Signatur-Key als Env gesetzt (TAURI_SIGNING_PRIVATE_KEY[_PATH] + _PASSWORD).
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = __dirname;
const conf = JSON.parse(
  fs.readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8')
);
const version = conf.version;
const bundleDir = path.join(root, 'src-tauri', 'target', 'release', 'bundle');

function sh(cmd) {
  execSync(cmd, { stdio: 'inherit' });
}

// Updater-Plattform-Key -> lokales Artefakt (+ .sig) und versionierter Ziel-Dateiname
const targets = [
  {
    key: 'windows-x86_64',
    src: path.join(bundleDir, 'nsis', `NutriDesk_${version}_x64-setup.exe`),
    remoteName: `NutriDesk_${version}_x64-setup.exe`,
  },
  {
    key: 'darwin-aarch64',
    src: path.join(bundleDir, 'macos', 'NutriDesk.app.tar.gz'),
    remoteName: `NutriDesk_${version}_aarch64.app.tar.gz`,
  },
];

const available = targets.filter(
  (t) => fs.existsSync(t.src) && fs.existsSync(t.src + '.sig')
);
if (available.length === 0) {
  console.error(
    'Keine signierten Artefakte gefunden. Erst bauen: "npm run build" (Windows) ' +
      'bzw. "npm run build:mac" (macOS) mit gesetztem Signatur-Key.'
  );
  process.exit(1);
}
console.log('Veroeffentliche Plattformen: ' + available.map((t) => t.key).join(', '));

function manifest(channel) {
  const platforms = {};
  for (const t of available) {
    const signature = fs.readFileSync(t.src + '.sig', 'utf8').trim();
    const base = channel === 'ptb' ? 'ptb/' : '';
    platforms[t.key] = {
      signature,
      url: `https://nutridesk.de/updates/${base}${t.remoteName}`,
    };
  }
  return JSON.stringify(
    { version, notes: `NutriDesk ${version}`, pub_date: new Date().toISOString(), platforms },
    null,
    2
  );
}

const tmp = path.join(os.tmpdir(), 'nd-manifest');
fs.mkdirSync(tmp, { recursive: true });
fs.writeFileSync(path.join(tmp, 'ptb.json'), manifest('ptb'));
fs.writeFileSync(path.join(tmp, 'stable.json'), manifest('stable'));

const remote = '/home/nutridesk.de/web/cdn/downloads';
console.log('Lade v' + version + ' hoch (PTB + Stable) …');
for (const t of available) {
  sh(`scp "${t.src}" vmd197921:${remote}/ptb/${t.remoteName}`);
  sh(`ssh vmd197921 "cp -f ${remote}/ptb/${t.remoteName} ${remote}/${t.remoteName}"`);
}
sh(`scp "${path.join(tmp, 'ptb.json')}" vmd197921:${remote}/ptb/tauri.json`);
sh(`scp "${path.join(tmp, 'stable.json')}" vmd197921:${remote}/tauri.json`);
console.log('Fertig. PTB sofort aktiv; Stable liefert nach SEC-002-Freischaltung aus.');
