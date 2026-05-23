/**
 * NULLBIT Launcher v2.0
 * Auto-update and bot launcher
 */

const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const { spawn } = require('child_process');
const cliProgress = require('cli-progress');
const chalk = require('chalk');
const figlet = require('figlet');

// ====== CONFIGURATION ======
const UPDATE_URL = 'https://api.github.com/repos/nullbit26/Nullbit-Client/releases/latest';
const CONFIG_FILE = 'config.json';
const BOT_EXE = 'AIBot.exe';
const BOT_EXE_BACKUP = 'AIBot.exe.backup';

// ====== GLITCH EFFECTS ======
const GLITCH_CHARS = ['_', '#', '@', '$', '%', '&', '!', '?', '0', '1', '█', '▓', '▒', '░'];

function glitchText(text, intensity = 0.3) {
  let result = '';
  for (let char of text) {
    if (Math.random() < intensity && char !== ' ') {
      const glitch = GLITCH_CHARS[Math.floor(Math.random() * GLITCH_CHARS.length)];
      result += Math.random() < 0.5 ? glitch : char.toUpperCase();
    } else {
      result += Math.random() < 0.5 ? char.toUpperCase() : char.toLowerCase();
    }
  }
  return result;
}

async function glitchPrint(text, colorFn = chalk.yellow, intensity = 0.2, delay = 50) {
  for (let i = 0; i < 3; i++) {
    process.stdout.write('\r' + colorFn(glitchText(text, intensity)));
    await sleep(delay);
  }
  process.stdout.write('\r' + colorFn(text) + '\n');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ====== UI ======
function printBanner() {
  console.clear();
  
  const logo = figlet.textSync('NULLBIT', { 
    font: 'ANSI Shadow',
    horizontalLayout: 'default'
  });
  
  console.log(chalk.yellowBright.bold(logo));
  console.log(chalk.blueBright('=================================================='));
  console.log(chalk.gray('  [ NULLBIT LAUNCHER v2.0 ]'));
  console.log(chalk.blueBright('=================================================='));
  console.log('');
}

function sysLog(message) {
  console.log(chalk.yellow('[ SYS ] ') + message);
}

function okLog(message) {
  console.log(chalk.blueBright('[ OK ] ') + message);
}

function errLog(message) {
  console.log(chalk.redBright('[ ERR ] ') + message);
}

function warnLog(message) {
  console.log(chalk.yellowBright('[ WARN ] ') + message);
}

/**
 * Load configuration
 */
function loadConfig() {
  try {
    const configPath = path.join(process.cwd(), CONFIG_FILE);
    if (!fs.existsSync(configPath)) {
      errLog(`CONFIG FILE NOT FOUND: ${CONFIG_FILE}`);
      return null;
    }
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    errLog(`CONFIG READ ERROR: ${error.message}`);
    return null;
  }
}

/**
 * Save configuration
 */
function saveConfig(config) {
  try {
    const configPath = path.join(process.cwd(), CONFIG_FILE);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    return true;
  } catch (error) {
    errLog(`CONFIG WRITE ERROR: ${error.message}`);
    return false;
  }
}

/**
 * Get current version from config
 */
function getCurrentVersion(config) {
  // Проверяем разные возможные поля версии
  return config.bot_version || config.version || config.minecraft?.version || '1.0.0';
}

/**
 * Compare semver versions
 * Returns: 1 if v1 > v2, -1 if v1 < v2, 0 if equal
 */
function compareVersions(v1, v2) {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);
  
  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }
  return 0;
}

/**
 * Check for updates on GitHub
 */
async function checkForUpdates() {
  sysLog('CONNECTING TO GITHUB...');
  await sleep(500);
  
  try {
    const response = await axios.get(UPDATE_URL, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Nullbit-Launcher'
      }
    });
    
    const data = response.data;
    
    if (!data || !data.tag_name) {
      warnLog('INVALID RESPONSE FROM GITHUB');
      return null;
    }
    
    // Извлекаем версию из tag_name (например, "v1.1" → "1.1")
    const version = data.tag_name.replace(/^v/, '');
    
    // Находим ассет AIBot.exe
    const asset = data.assets?.find(a => a.name === 'AIBot.exe');
    if (!asset) {
      warnLog('ASSET AIBOT.EXE NOT FOUND IN RELEASE');
      return null;
    }
    
    return {
      version: version,
      tagName: data.tag_name,
      downloadUrl: asset.browser_download_url,
      releaseNotes: data.body || 'No description',
      fileSize: asset.size || 0
    };
  } catch (error) {
    if (error.code === 'ECONNABORTED') {
      warnLog('CONNECTION TIMEOUT');
    } else if (error.response) {
      warnLog(`GITHUB ERROR: ${error.response.status}`);
    } else {
      warnLog(`NETWORK ERROR: ${error.message}`);
    }
    return null;
  }
}

/**
 * Download file with progress bar
 */
async function downloadFile(url, destPath, fileSize = 0) {
  console.log('');
  sysLog('DOWNLOADING UPDATE...');
  
  const progressBar = new cliProgress.SingleBar({
    format: chalk.yellowBright('DOWNLOADING ') + '[' + chalk.blueBright('{bar}') + '] {percentage}% | {value}/{total} MB',
    barCompleteChar: '█',
    barIncompleteChar: '░',
    hideCursor: true,
    stopOnComplete: true
  });
  
  try {
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'stream',
      timeout: 300000,
      headers: {
        'User-Agent': 'NULLBIT-Launcher/2.0'
      }
    });
    
    const totalBytes = parseInt(response.headers['content-length']) || fileSize;
    let downloadedBytes = 0;
    
    const toMB = (bytes) => (bytes / 1024 / 1024).toFixed(0);
    
    progressBar.start(totalBytes, 0, {
      percentage: 0,
      value: 0,
      total: toMB(totalBytes)
    });
    
    const writer = fs.createWriteStream(destPath);
    
    response.data.on('data', (chunk) => {
      downloadedBytes += chunk.length;
      
      progressBar.update(downloadedBytes, {
        percentage: Math.round((downloadedBytes / totalBytes) * 100),
        value: toMB(downloadedBytes),
        total: toMB(totalBytes)
      });
    });
    
    response.data.pipe(writer);
    
    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        progressBar.stop();
        console.log('');
        resolve(true);
      });
      
      writer.on('error', (error) => {
        progressBar.stop();
        reject(error);
      });
    });
  } catch (error) {
    progressBar.stop();
    throw error;
  }
}

/**
 * Install update
 */
async function installUpdate(updateInfo, config) {
  const tempFile = path.join(process.cwd(), 'AIBot.exe.tmp');
  const botExePath = path.join(process.cwd(), BOT_EXE);
  const backupPath = path.join(process.cwd(), BOT_EXE_BACKUP);
  
  try {
    console.log('');
    console.log(chalk.redBright.bold('[ ! ] ' + glitchText('NEW BUILD DETECTED', 0.4)));
    console.log(chalk.redBright.bold('[ ! ] ' + glitchText('INSTALLING UPDATE...', 0.4)));
    console.log('');
    
    sysLog('CURRENT VERSION: ' + getCurrentVersion(config));
    sysLog('NEW VERSION: ' + updateInfo.version);
    console.log('');
    
    if (updateInfo.releaseNotes && updateInfo.releaseNotes !== 'No description') {
      console.log(chalk.yellowBright('=== PATCH NOTES ' + (updateInfo.tagName || updateInfo.version) + ' ==='));
      console.log(chalk.gray(updateInfo.releaseNotes));
      console.log('');
      sysLog('READING PATCH NOTES...');
      await sleep(2000);
    }
    
    await downloadFile(updateInfo.downloadUrl, tempFile, updateInfo.fileSize);
    
    if (!fs.existsSync(tempFile)) {
      throw new Error('FILE NOT DOWNLOADED');
    }
    
    const stats = fs.statSync(tempFile);
    if (stats.size < 1000000) {
      throw new Error(`SUSPICIOUS FILE SIZE: ${stats.size} bytes`);
    }
    
    okLog('DOWNLOAD COMPLETE');
    
    if (fs.existsSync(botExePath)) {
      try {
        if (fs.existsSync(backupPath)) {
          fs.removeSync(backupPath);
        }
        fs.copyFileSync(botExePath, backupPath);
        sysLog('BACKUP CREATED');
      } catch (e) {
        warnLog('BACKUP ERROR: ' + e.message);
      }
    }
    
    try {
      if (fs.existsSync(botExePath)) {
        fs.removeSync(botExePath);
      }
      fs.renameSync(tempFile, botExePath);
      okLog('BOT UPDATED');
    } catch (error) {
      if (fs.existsSync(backupPath) && !fs.existsSync(botExePath)) {
        fs.copyFileSync(backupPath, botExePath);
      }
      throw new Error(`REPLACE ERROR: ${error.message}`);
    }
    
    config.bot_version = updateInfo.version;
    if (saveConfig(config)) {
      okLog('CONFIG UPDATED');
    }
    
    try {
      if (fs.existsSync(backupPath)) {
        fs.removeSync(backupPath);
      }
    } catch (e) {}
    
    console.log('');
    okLog('UPDATE COMPLETE');
    return true;
    
  } catch (error) {
    // Очистка временного файла при ошибке
    if (fs.existsSync(tempFile)) {
      try {
        fs.removeSync(tempFile);
      } catch (e) {}
    }
    throw error;
  }
}

/**
 * Launch bot process (stays alive to monitor the bot)
 */
function launchBot() {
  const botExePath = path.join(process.cwd(), BOT_EXE);
  
  if (!fs.existsSync(botExePath)) {
    errLog(`FILE NOT FOUND: ${BOT_EXE}`);
    console.log(chalk.yellow('  Make sure Launcher.exe is in the same folder as ' + BOT_EXE));
    return null;
  }
  
  console.log('');
  sysLog('INITIALIZING...');
  
  try {
    const child = spawn(botExePath, [], {
      detached: false,
      stdio: 'inherit',
      cwd: process.cwd()
    });
    
    child.on('error', (error) => {
      errLog(`LAUNCH ERROR: ${error.message}`);
    });
    
    child.on('exit', (code) => {
      console.log('');
      if (code === 0) {
        okLog('NULLBIT STOPPED');
      } else {
        errLog(`NULLBIT EXITED (code: ${code})`);
      }
      process.exit(code);
    });
    
    return child;
  } catch (error) {
    errLog(`CANNOT LAUNCH: ${error.message}`);
    return null;
  }
}

/**
 * Main function
 */
async function main() {
  printBanner();
  
  const config = loadConfig();
  if (!config) {
    console.log('');
    errLog('CONFIG NOT FOUND');
    console.log(chalk.yellow('  Place config.json in the same folder as the launcher'));
    process.exit(1);
  }
  
  const currentVersion = getCurrentVersion(config);
  sysLog('VERSION: ' + currentVersion);
  sysLog('UPDATE SERVER: ' + UPDATE_URL);
  console.log('');
  
  const updateInfo = await checkForUpdates();
  
  if (updateInfo) {
    const comparison = compareVersions(updateInfo.version, currentVersion);
    
    if (comparison > 0) {
      try {
        await installUpdate(updateInfo, config);
        console.log('');
      } catch (error) {
        console.log('');
        errLog('UPDATE FAILED: ' + error.message);
        warnLog('LAUNCHING CURRENT VERSION');
        console.log('');
      }
    } else if (comparison === 0) {
      okLog('UP TO DATE');
    } else {
      sysLog('LOCAL VERSION IS NEWER THAN SERVER');
    }
  } else {
    warnLog('UPDATES UNAVAILABLE');
    console.log('');
  }
  
  const child = launchBot();
  
  if (!child) {
    process.exit(1);
  }
  
  console.log('');
  console.log(chalk.greenBright('=================================================='));
  console.log(chalk.greenBright.bold('[+] NULLBIT IS RUNNING'));
  console.log(chalk.gray('    Close this window to stop the bot'));
  console.log(chalk.greenBright('=================================================='));
  console.log('');
  
  process.on('SIGINT', () => {
    console.log('');
    sysLog('SHUTTING DOWN...');
    if (child && !child.killed) {
      child.kill();
    }
    process.exit(0);
  });
  
  process.on('SIGTERM', () => {
    if (child && !child.killed) {
      child.kill();
    }
    process.exit(0);
  });
}

main().catch(error => {
  console.log('');
  errLog('CRITICAL ERROR: ' + error.message);
  console.error(error);
  process.exit(1);
});
