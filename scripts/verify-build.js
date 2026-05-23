/**
 * Verify Build Setup
 * Проверка готовности к сборке релиза
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
  console.log(colors[color] + message + colors.reset);
}

function checkMark(success) {
  return success ? colors.green + '✓' + colors.reset : colors.red + '✗' + colors.reset;
}

console.log(colors.cyan + '\n╔════════════════════════════════════════════════════════╗' + colors.reset);
console.log(colors.cyan + '║' + colors.reset + '        AI Bot - Build Verification Check            ' + colors.cyan + '║' + colors.reset);
console.log(colors.cyan + '╚════════════════════════════════════════════════════════╝' + colors.reset);

let allPassed = true;

// 1. Проверка файлов
console.log('\n📁 Checking required files...');

const requiredFiles = [
  'scripts/build.js',
  'scripts/license-check.js',
  'package.json',
  'index.js',
  'startBot.js'
];

for (const file of requiredFiles) {
  const exists = fs.existsSync(path.join(__dirname, '..', file));
  console.log(`  ${checkMark(exists)} ${file}`);
  if (!exists) allPassed = false;
}

// 2. Проверка зависимостей
console.log('\n📦 Checking npm packages...');

const requiredPackages = [
  'javascript-obfuscator',
  'pkg',
  'fs-extra',
  'glob',
  'axios'
];

const pkgPath = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

for (const pkg of requiredPackages) {
  const exists = allDeps[pkg] !== undefined;
  console.log(`  ${checkMark(exists)} ${pkg}`);
  if (!exists) allPassed = false;
}

// 3. Проверка KeyAuth конфигурации
console.log('\n🔐 Checking KeyAuth configuration...');

const licenseCheckPath = path.join(__dirname, 'license-check.js');
const licenseCheckContent = fs.readFileSync(licenseCheckPath, 'utf8');

const hasAppName = !licenseCheckContent.includes("appName: ''") && 
                   licenseCheckContent.match(/appName:\s*['"][^'"]+['"]/);
const hasOwnerId = !licenseCheckContent.includes("ownerId: ''") && 
                   licenseCheckContent.match(/ownerId:\s*['"][^'"]+['"]/);
const hasSecret = !licenseCheckContent.includes("appSecret: ''") && 
                  licenseCheckContent.match(/appSecret:\s*['"][^'"]+['"]/);

console.log(`  ${checkMark(hasAppName)} KeyAuth appName configured`);
console.log(`  ${checkMark(hasOwnerId)} KeyAuth ownerId configured`);
console.log(`  ${checkMark(hasSecret)} KeyAuth appSecret configured`);

if (!hasAppName || !hasOwnerId || !hasSecret) {
  allPassed = false;
  log('\n⚠️  KeyAuth not configured! Edit scripts/license-check.js', 'yellow');
}

// 4. Проверка npm
console.log('\n🔧 Checking npm availability...');

try {
  const npmVersion = execSync('npm --version', { encoding: 'utf8' }).trim();
  console.log(`  ${checkMark(true)} npm v${npmVersion}`);
} catch {
  console.log(`  ${checkMark(false)} npm not found`);
  allPassed = false;
}

// 5. Проверка Node.js версии
console.log('\n🟢 Checking Node.js version...');

try {
  const nodeVersion = process.version;
  const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0]);
  const isCompatible = majorVersion >= 16;
  console.log(`  ${checkMark(isCompatible)} Node.js ${nodeVersion} (need >= 16)`);
  if (!isCompatible) allPassed = false;
} catch {
  console.log(`  ${checkMark(false)} Cannot detect Node.js version`);
  allPassed = false;
}

// Итог
console.log(colors.cyan + '\n╔════════════════════════════════════════════════════════╗' + colors.reset);

if (allPassed) {
  console.log(colors.cyan + '║' + colors.green + '           ✓ READY TO BUILD!                           ' + colors.cyan + '║' + colors.reset);
  console.log(colors.cyan + '╠════════════════════════════════════════════════════════╣' + colors.reset);
  console.log(colors.cyan + '║' + colors.reset + '  Run: npm run build                                  ' + colors.cyan + '║' + colors.reset);
  console.log(colors.cyan + '╚════════════════════════════════════════════════════════╝' + colors.reset);
} else {
  console.log(colors.cyan + '║' + colors.red + '           ✗ SETUP INCOMPLETE                          ' + colors.cyan + '║' + colors.reset);
  console.log(colors.cyan + '╠════════════════════════════════════════════════════════╣' + colors.reset);
  console.log(colors.cyan + '║' + colors.yellow + '  Fix the issues above and run verify again           ' + colors.cyan + '║' + colors.reset);
  console.log(colors.cyan + '╚════════════════════════════════════════════════════════╝' + colors.reset);
}

console.log('');
