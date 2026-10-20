// Zozbiera licencie všetkých závislostí, ktoré sa dostanú do hotovej aplikácie, do priečinka licenses/.
// Spúšťa sa pred zostavením vydania:  npm run notices
// Výsledok sa ukladá aj do repozitára, aby bol vidieť, čo všetko program obsahuje.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'licenses');
fs.mkdirSync(outDir, { recursive: true });

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const found = new Map(); // "meno@verzia" -> { dir, json }

function visit(name, fromDir) {
  let pjPath;
  try {
    pjPath = require.resolve(`${name}/package.json`, { paths: [fromDir] });
  } catch {
    return; // voliteľná závislosť, ktorá sa nenainštalovala
  }
  const dir = path.dirname(pjPath);
  const json = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
  const key = `${json.name}@${json.version}`;
  if (found.has(key)) return;
  found.set(key, { dir, json });
  for (const dep of Object.keys(json.dependencies || {})) visit(dep, dir);
}

for (const dep of Object.keys(pkg.dependencies || {})) visit(dep, root);

const licenseFile = (dir) => {
  const f = fs.readdirSync(dir).find((n) => /^(licen[sc]e|copying)(\.(md|txt))?$/i.test(n));
  if (f) return fs.readFileSync(path.join(dir, f), 'utf8').trim();
  // niektoré balíčky majú licenciu len v README, v časti "License"
  const readme = fs.readdirSync(dir).find((n) => /^readme(\.(md|txt))?$/i.test(n));
  if (readme) {
    const text = fs.readFileSync(path.join(dir, readme), 'utf8');
    const m = text.match(/^(?:#+[ \t]*)?licen[sc]e[ \t]*\r?\n(?:[-=]+[ \t]*\r?\n)?[\s\S]*$/im);
    if (m) {
      const body = m[0].split(/\r?\n/).filter((l) => !/^\[[^\]]+\]:\s/.test(l)).join('\n').trim();
      return `(Text prevzatý z README balíčka)\n\n${body}`;
    }
  }
  return null;
};

const sep = '='.repeat(78);
const parts = [
  'Licencie balíčkov npm, ktoré sú súčasťou programu StreamPlay.',
  'License texts of the npm packages bundled with StreamPlay.',
  '',
];
const rows = [...found.entries()].sort(([a], [b]) => a.localeCompare(b));
for (const [key, { dir, json }] of rows) {
  const license = typeof json.license === 'string' ? json.license : json.license ? JSON.stringify(json.license) : 'pozri text nižšie';
  const home = json.homepage || (json.repository && (json.repository.url || json.repository)) || '';
  parts.push(sep, `${key}  |  ${license}${home ? '  |  ' + home : ''}`, sep, licenseFile(dir) || '(Balíček neobsahuje samostatný súbor s licenciou; licencia je uvedená vyššie.)', '');
}
fs.writeFileSync(path.join(outDir, 'npm-packages.txt'), parts.join('\n'), 'utf8');

// ffmpeg: licencia GPL v3 a informácie o zostavení (verzia, zdrojový kód, použité knižnice)
const ff = path.join(root, 'node_modules', 'ffmpeg-static');
fs.copyFileSync(path.join(ff, 'ffmpeg.exe.LICENSE'), path.join(outDir, 'ffmpeg-GPL-3.0.txt'));
fs.copyFileSync(path.join(ff, 'ffmpeg.exe.README'), path.join(outDir, 'ffmpeg-build-info.txt'));

console.log(`Licencie zapísané do ${outDir}: ${rows.length} balíčkov npm + ffmpeg`);
for (const [key, { json }] of rows) console.log(`  ${key}  ${json.license || '(bez poľa license)'}`);
