/**
 * Build Script for AI Bot Release
 * Сборка обфусцированного .exe с лицензионной защитой
 * Использует esbuild для создания единого bundle
 */

const fs = require('fs-extra');
const path = require('path');
const { execSync } = require('child_process');
const JavaScriptObfuscator = require('javascript-obfuscator');
const esbuild = require('esbuild');

// Конфигурация сборки
const BUILD_CONFIG = {
  sourceDir: path.join(__dirname, '..'),
  releaseDir: path.join(__dirname, '..', 'Release'),
  tempDir: path.join(__dirname, '..', 'Release', 'temp_build'),
  launcherTempDir: path.join(__dirname, '..', 'Release', 'temp_launcher'),
  bundleFile: 'bundle.js',
  obfuscatedFile: 'app.js',
  entryPoint: 'index.js',
  outputExe: 'AIBot.exe',
  launcherExe: 'Launcher.exe',
  launcherEntry: 'scripts/launcher.js',
  nodeVersion: '18'
};

// Цвета для консоли
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m'
};

function log(message, color = 'white') {
  console.log(colors[color] + message + colors.reset);
}

function logStep(stepNum, message) {
  console.log('\n' + colors.cyan + `[${stepNum}/7]` + colors.reset + ' ' + colors.yellow + message + colors.reset);
}

function logSuccess(message) {
  console.log(colors.green + '✓ ' + message + colors.reset);
}

function logError(message) {
  console.log(colors.red + '✗ ' + message + colors.reset);
}

/**
 * Шаг 1: Очистка и создание папки Release
 */
async function prepareReleaseFolder() {
  logStep(1, 'Preparing Release folder...');
  
  try {
    if (fs.existsSync(BUILD_CONFIG.releaseDir)) {
      await fs.remove(BUILD_CONFIG.releaseDir);
      log('Cleaned old Release folder');
    }
    
    // Создаем новые папки
    await fs.ensureDir(BUILD_CONFIG.releaseDir);
    await fs.ensureDir(BUILD_CONFIG.tempDir);
    await fs.ensureDir(BUILD_CONFIG.launcherTempDir);
    
    logSuccess('Release folder prepared');
    return true;
  } catch (error) {
    logError(`Failed to prepare Release folder: ${error.message}`);
    return false;
  }
}

/**
 * Шаг 2: Сборка bundle через esbuild
 */
async function buildBundle() {
  logStep(2, 'Building bundle with esbuild...');
  
  try {
    const entryPoint = path.join(BUILD_CONFIG.sourceDir, BUILD_CONFIG.entryPoint);
    const bundlePath = path.join(BUILD_CONFIG.tempDir, BUILD_CONFIG.bundleFile);
    
    log('Bundling all modules into single file...');
    
    await esbuild.build({
      entryPoints: [entryPoint],
      bundle: true,
      platform: 'node',
      target: `node${BUILD_CONFIG.nodeVersion}`,
      outfile: bundlePath,
      format: 'cjs',
      external: [], // Встраиваем всё
      minify: true, // Минифицируем для уменьшения размера
      sourcemap: false,
      allowOverwrite: true,
      // Важно: разрешаем require динамических путей
      banner: {
        js: `
// Patch require for pkg snapshot
const originalRequire = require;
require = function(id) {
  try {
    return originalRequire(id);
  } catch (e) {
    // Try relative to __dirname
    if (id.startsWith('./') || id.startsWith('../')) {
      try {
        return originalRequire(path.join(__dirname, id));
      } catch (e2) {
        throw e;
      }
    }
    throw e;
  }
};
`
      }
    });
    
    logSuccess(`Bundle created: ${BUILD_CONFIG.bundleFile}`);
    const stats = fs.statSync(bundlePath);
    log(`Bundle size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
    
    return true;
  } catch (error) {
    logError(`Bundle failed: ${error.message}`);
    console.error(error);
    return false;
  }
}

/**
 * Шаг 3: Минификация bundle (обфускация отключена из-за размера)
 */
async function obfuscateBundle() {
  logStep(3, 'Minifying bundle (obfuscation skipped for size)...');
  
  try {
    const bundlePath = path.join(BUILD_CONFIG.tempDir, BUILD_CONFIG.bundleFile);
    const obfuscatedPath = path.join(BUILD_CONFIG.tempDir, BUILD_CONFIG.obfuscatedFile);
    
    // Для большого bundle просто копируем файл (обфускация вызывает ошибки на 400MB+ файлах)
    // Защита достигается через:
    // 1. Сборка в один bundle через esbuild (уже сложно разобрать)
    // 2. Компиляция в .exe через pkg (код внутри бинарника)
    await fs.copy(bundlePath, obfuscatedPath);
    
    logSuccess('Bundle prepared (minified by esbuild)');
    return true;
  } catch (error) {
    logError(`Bundle preparation failed: ${error.message}`);
    return false;
  }
}

/**
 * Шаг 4: Создание entry point с лицензией
 */
async function createEntryPoint() {
  logStep(4, 'Creating entry point with license check...');
  
  try {
    const obfuscatedPath = path.join(BUILD_CONFIG.tempDir, BUILD_CONFIG.obfuscatedFile);
    const entryPath = path.join(BUILD_CONFIG.tempDir, 'index.js');
    
    // Читаем обфусцированный код
    const appCode = await fs.readFile(obfuscatedPath, 'utf8');
    
    // Создаем entry point с лицензией + встроенный бот
    const entryCode = generateEntryWithLicense(appCode);
    
    await fs.writeFile(entryPath, entryCode);
    
    logSuccess('Entry point created');
    return true;
  } catch (error) {
    logError(`Failed to create entry point: ${error.message}`);
    return false;
  }
}

/**
 * Генерация entry point с встроенной лицензией и кодом бота
 */
function generateEntryWithLicense(appCode) {
  return `/**
 * AI Bot - License Protected & Bundled
 * Auto-generated by build script
 */

const axios = require('axios');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ====== КОНФИГУРАЦИЯ KEYAUTH ======
const KEYAUTH_CONFIG = {
  appName: 'Nullbit',
  ownerId: '47IOqyDjNC',
  appSecret: 'daf5f53ecdce23b1872224572b0e1b128288d6fde5ed95b26c07666a5331e6b6',
  version: '1.0'
};

const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m'
};

function generateHWID() {
  try {
    const interfaces = os.networkInterfaces();
    let macAddress = '';
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.mac && iface.mac !== '00:00:00:00:00:00' && !iface.internal) {
          macAddress = iface.mac;
          break;
        }
      }
      if (macAddress) break;
    }
    const cpuInfo = os.cpus()[0]?.model || 'unknown';
    const hwidString = macAddress + '-' + cpuInfo + '-' + os.hostname();
    return crypto.createHash('sha256').update(hwidString).digest('hex').substring(0, 32);
  } catch (error) {
    return crypto.createHash('sha256').update(os.hostname() + os.platform() + os.arch()).digest('hex').substring(0, 32);
  }
}

async function initSession() {
  try {
    const response = await axios.get('https://keyauth.win/api/1.2/', {
      params: {
        type: 'init',
        name: KEYAUTH_CONFIG.appName,
        ownerid: KEYAUTH_CONFIG.ownerId,
        version: KEYAUTH_CONFIG.version
      },
      timeout: 15000
    });
    const data = response.data;
    if (data.success && data.sessionid) {
      return { success: true, sessionid: data.sessionid };
    } else {
      return { success: false, message: data.message || 'Failed to initialize session' };
    }
  } catch (error) {
    return { success: false, message: 'Session init error: ' + error.message };
  }
}

async function verifyLicense(licenseKey) {
  if (!KEYAUTH_CONFIG.appName || !KEYAUTH_CONFIG.ownerId || !KEYAUTH_CONFIG.appSecret) {
    return { success: false, message: 'KeyAuth not configured' };
  }
  if (!licenseKey || licenseKey.trim() === '') {
    return { success: false, message: 'License key not found in config.json' };
  }
  const sessionResult = await initSession();
  if (!sessionResult.success) {
    return { success: false, message: 'Failed to initialize session: ' + sessionResult.message };
  }
  const sessionid = sessionResult.sessionid;
  const hwid = generateHWID();
  try {
    const response = await axios.post('https://keyauth.win/api/1.2/', {
      type: 'license',
      key: licenseKey.trim(),
      hwid: hwid,
      sessionid: sessionid,
      name: KEYAUTH_CONFIG.appName,
      ownerid: KEYAUTH_CONFIG.ownerId,
      secret: KEYAUTH_CONFIG.appSecret,
      version: KEYAUTH_CONFIG.version
    }, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 });
    
    const data = response.data;
    if (data.success) {
      return { success: true, message: 'License verified', data: { username: data.info?.username, hwid: hwid } };
    } else {
      let errorMessage = data.message || 'Unknown error';
      if (errorMessage.toLowerCase().includes('hwid')) {
        errorMessage = 'HWID mismatch! Your key is bound to another device. Contact support. HWID: ' + hwid;
      }
      return { success: false, message: errorMessage };
    }
  } catch (error) {
    return { success: false, message: 'Network error: ' + error.message };
  }
}

function printBanner(result) {
  console.log('\\n' + colors.cyan + '╔════════════════════════════════════════════════════════╗' + colors.reset);
  console.log(colors.cyan + '║' + colors.reset + '           AI Bot - License Verification              ' + colors.cyan + '║' + colors.reset);
  console.log(colors.cyan + '╠════════════════════════════════════════════════════════╣' + colors.reset);
  if (result.success) {
    console.log(colors.cyan + '║' + colors.green + '  ✅ License: VERIFIED                                 ' + colors.cyan + '║' + colors.reset);
    console.log(colors.cyan + '║' + colors.reset + '  👤 User: ' + (result.data?.username || 'N/A').padEnd(35) + colors.cyan + '║' + colors.reset);
    console.log(colors.cyan + '╚════════════════════════════════════════════════════════╝' + colors.reset);
    console.log(colors.green + '\\n✓ Starting bot...\\n' + colors.reset);
  } else {
    console.log(colors.cyan + '║' + colors.red + '  ❌ License: FAILED                                    ' + colors.cyan + '║' + colors.reset);
    console.log(colors.cyan + '║' + colors.reset + '  📝 ' + (result.message.substring(0, 46) || 'Unknown').padEnd(46) + colors.cyan + '║' + colors.reset);
    console.log(colors.cyan + '╚════════════════════════════════════════════════════════╝' + colors.reset);
    console.log(colors.red + '\\n✗ ' + result.message + '\\n' + colors.reset);
  }
}

async function checkLicense() {
  try {
    const configPath = path.join(process.cwd(), 'config.json');
    if (!fs.existsSync(configPath)) {
      printBanner({ success: false, message: 'config.json not found in ' + process.cwd() });
      return false;
    }
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!config.license_key) {
      printBanner({ success: false, message: 'license_key not found in config.json' });
      return false;
    }
    const result = await verifyLicense(config.license_key);
    printBanner(result);
    return result.success;
  } catch (error) {
    printBanner({ success: false, message: error.message });
    return false;
  }
}

// ====== EMBEDDED BOT CODE ======
const embeddedBotCode = ${JSON.stringify(appCode)};

// ====== MAIN ENTRY ======
async function main() {
  const licenseValid = await checkLicense();
  if (!licenseValid) {
    console.log(colors.red + '\\nPress any key to exit...' + colors.reset);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', () => process.exit(1));
    setTimeout(() => process.exit(1), 5000);
    return;
  }
  
  // Execute embedded bot code
  try {
    eval(embeddedBotCode);
  } catch (error) {
    console.error('Failed to start bot:', error.message);
    process.exit(1);
  }
}

main();
`;
}

/**
 * Шаг 5: Сборка с помощью pkg
 */
async function buildExecutable() {
  logStep(5, 'Building executable with pkg...');
  
  try {
    // Создаем package.json для pkg
    const pkgJson = {
      name: 'ai_bot',
      version: '1.0.0',
      main: 'index.js',
      bin: 'index.js',
      pkg: {
        targets: [`node${BUILD_CONFIG.nodeVersion}-win-x64`],
        outputPath: BUILD_CONFIG.releaseDir
      }
    };
    
    await fs.writeJson(path.join(BUILD_CONFIG.tempDir, 'package.json'), pkgJson, { spaces: 2 });
    
    const pkgCommand = `npx pkg . --targets node${BUILD_CONFIG.nodeVersion}-win-x64 --output ${path.join(BUILD_CONFIG.releaseDir, BUILD_CONFIG.outputExe)}`;
    
    log('Running pkg...');
    
    execSync(pkgCommand, {
      cwd: BUILD_CONFIG.tempDir,
      stdio: 'inherit'
    });
    
    logSuccess(`Executable built: ${BUILD_CONFIG.outputExe}`);
    return true;
  } catch (error) {
    logError(`Build failed: ${error.message}`);
    return false;
  }
}

/**
 * Шаг 6: Сборка Launcher.exe
 */
async function buildLauncher() {
  logStep(6, 'Building Launcher.exe...');
  
  try {
    // Создаем временную папку для лаунчера
    await fs.ensureDir(BUILD_CONFIG.launcherTempDir);
    
    // Копируем launcher.js
    const launcherSource = path.join(BUILD_CONFIG.sourceDir, BUILD_CONFIG.launcherEntry);
    const launcherDest = path.join(BUILD_CONFIG.launcherTempDir, 'launcher.js');
    await fs.copy(launcherSource, launcherDest);
    
    // Копируем критичные зависимости для лаунчера
    log('Copying launcher dependencies...');
    const depsToCopy = ['chalk', 'cli-progress', 'figlet', 'axios', 'fs-extra'];
    for (const dep of depsToCopy) {
      const src = path.join(BUILD_CONFIG.sourceDir, 'node_modules', dep);
      const dest = path.join(BUILD_CONFIG.launcherTempDir, 'node_modules', dep);
      if (fs.existsSync(src)) {
        await fs.copy(src, dest);
      }
    }
    
    // Создаем package.json для лаунчера
    const pkgJson = {
      name: 'ai_bot_launcher',
      version: '2.1.0',
      main: 'launcher.js',
      bin: 'launcher.js',
      pkg: {
        targets: [`node${BUILD_CONFIG.nodeVersion}-win-x64`],
        outputPath: BUILD_CONFIG.releaseDir
      },
      dependencies: {
        'axios': '^1.6.0',
        'chalk': '^4.1.2',
        'cli-progress': '^3.12.0',
        'figlet': '^1.11.0',
        'fs-extra': '^11.0.0'
      }
    };
    
    await fs.writeJson(path.join(BUILD_CONFIG.launcherTempDir, 'package.json'), pkgJson, { spaces: 2 });
    
    // Собираем через pkg
    const pkgCommand = `npx pkg . --targets node${BUILD_CONFIG.nodeVersion}-win-x64 --output ${path.join(BUILD_CONFIG.releaseDir, BUILD_CONFIG.launcherExe)}`;
    
    log('Building launcher with pkg...');
    
    execSync(pkgCommand, {
      cwd: BUILD_CONFIG.launcherTempDir,
      stdio: 'inherit'
    });
    
    logSuccess(`Launcher built: ${BUILD_CONFIG.launcherExe}`);
    return true;
  } catch (error) {
    logError(`Launcher build failed: ${error.message}`);
    return false;
  }
}

/**
 * Шаг 7: Создание config.json и очистка
 */
async function createConfigAndCleanup() {
  logStep(7, 'Creating config template and cleanup...');
  
  try {
    const configTemplate = {
      license_key: 'ENTER_YOUR_LICENSE_KEY_HERE',
      bot_version: '1.0.0',
      minecraft: {
        host: 'mc.server.com',
        port: 25565,
        version: '1.21.11',
        auth: 'offline',
        username: 'Nullbit',
        password: ''
      },
      bot: {
        allowed_user: 'YOUR_MINECRAFT_NICKNAME',
        server_password: ''
      }
    };
    
    await fs.writeJson(path.join(BUILD_CONFIG.releaseDir, 'config.json'), configTemplate, { spaces: 2 });
    
    const readmeContent = `# Nullbit AI Bot

## Setup

1. Open config.json with any text editor (Notepad, Notepad++ etc.)
2. Fill in the fields:

   license_key        — your license key

   minecraft:
     host             — server IP (e.g. play.myserver.com)
     port             — server port (usually 25565)
     version          — Minecraft version (do not change unless needed)
     auth             — offline (cracked) or microsoft (Mojang license)
     username         — bot name in game (default: Nullbit)
     password         — server /login password if required (leave empty otherwise)

   bot:
     allowed_user     — YOUR Minecraft nickname (only you can command the bot)
     server_password  — server /register password if required (leave empty otherwise)

3. Run Launcher.exe (recommended - auto-update)
   or AIBot.exe (direct launch without updates)

## Files

- Launcher.exe  — launcher with auto-update (recommended)
- AIBot.exe     — bot (direct launch)
- config.json   — the only file you need to edit

## Requirements

- Windows 10/11 x64
- Internet connection (license verification)
`;
    
    await fs.writeFile(path.join(BUILD_CONFIG.releaseDir, 'README.txt'), readmeContent);
    
    // Очистка
    await fs.remove(BUILD_CONFIG.tempDir);
    await fs.remove(BUILD_CONFIG.launcherTempDir);
    
    logSuccess('Config template created and temp files cleaned');
    return true;
  } catch (error) {
    logError(`Cleanup failed: ${error.message}`);
    return false;
  }
}

/**
 * Главная функция сборки
 */
async function build() {
  console.log(colors.cyan + '\n╔════════════════════════════════════════════════════════╗' + colors.reset);
  console.log(colors.cyan + '║' + colors.reset + '           AI Bot Release Builder v2.1                ' + colors.cyan + '║' + colors.reset);
  console.log(colors.cyan + '║' + colors.reset + '       (esbuild + pkg + Launcher with Auto-Update)    ' + colors.cyan + '║' + colors.reset);
  console.log(colors.cyan + '╚════════════════════════════════════════════════════════╝' + colors.reset);
  
  const startTime = Date.now();
  
  const steps = [
    prepareReleaseFolder,
    buildBundle,
    obfuscateBundle,
    createEntryPoint,
    buildExecutable,
    buildLauncher,
    createConfigAndCleanup
  ];
  
  for (const step of steps) {
    const success = await step();
    if (!success) {
      logError('Build process failed!');
      process.exit(1);
    }
  }
  
  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  
  console.log(colors.cyan + '\n╔════════════════════════════════════════════════════════╗' + colors.reset);
  console.log(colors.cyan + '║' + colors.green + '                 BUILD SUCCESSFUL!                    ' + colors.cyan + '║' + colors.reset);
  console.log(colors.cyan + '╠════════════════════════════════════════════════════════╣' + colors.reset);
  console.log(colors.cyan + '║' + colors.reset + `  📦 AIBot.exe: Release/${BUILD_CONFIG.outputExe}`.padEnd(56) + colors.cyan + '║' + colors.reset);
  console.log(colors.cyan + '║' + colors.reset + `  🚀 Launcher.exe: Release/${BUILD_CONFIG.launcherExe}`.padEnd(56) + colors.cyan + '║' + colors.reset);
  console.log(colors.cyan + '║' + colors.reset + `  ⚙️  Config: Release/config.json`.padEnd(56) + colors.cyan + '║' + colors.reset);
  console.log(colors.cyan + '║' + colors.reset + `  ⏱️  Time: ${duration}s`.padEnd(56) + colors.cyan + '║' + colors.reset);
  console.log(colors.cyan + '╚════════════════════════════════════════════════════════╝' + colors.reset);
  
  log('\n✅ Build complete! All files are in the Release/ folder', 'green');
}

// Запуск сборки
build().catch(error => {
  logError(`Unexpected error: ${error.message}`);
  console.error(error);
  process.exit(1);
});
