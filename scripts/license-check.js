/**
 * KeyAuth License Verification Module
 * Проверка лицензионного ключа через KeyAuth API
 */

const axios = require('axios');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ====== КОНФИГУРАЦИЯ KEYAUTH (ЗАПОЛНИ ПЕРЕД СБОРКОЙ) ======
const KEYAUTH_CONFIG = {
  appName: 'Nullbit',           // Название приложения в KeyAuth
  ownerId: '47IOqyDjNC',           // Owner ID из KeyAuth панели
  appSecret: 'daf5f53ecdce23b1872224572b0e1b128288d6fde5ed95b26c07666a5331e6b6',         // Secret ключ приложения
  version: '1.0'           // Версия приложения
};

// Цвета для консоли
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m'
};

/**
 * Генерация HWID (Hardware ID) на основе системной информации
 */
function generateHWID() {
  try {
    const interfaces = os.networkInterfaces();
    let macAddress = '';
    
    // Ищем первый валидный MAC-адрес
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.mac && iface.mac !== '00:00:00:00:00:00' && !iface.internal) {
          macAddress = iface.mac;
          break;
        }
      }
      if (macAddress) break;
    }
    
    // Комбинируем MAC + информацию о CPU для создания уникального HWID
    const cpuInfo = os.cpus()[0]?.model || 'unknown';
    const hwidString = `${macAddress}-${cpuInfo}-${os.hostname()}`;
    
    // Хешируем для получения фиксированной длины
    return crypto.createHash('sha256').update(hwidString).digest('hex').substring(0, 32);
  } catch (error) {
    // Fallback: генерируем на основе случайных данных если не удалось получить системную инфо
    return crypto.createHash('sha256').update(os.hostname() + os.platform() + os.arch()).digest('hex').substring(0, 32);
  }
}

/**
 * Инициализация сессии KeyAuth (получение sessionid)
 * @returns {Promise<{success: boolean, sessionid?: string, message?: string}>}
 */
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
      return {
        success: true,
        sessionid: data.sessionid
      };
    } else {
      return {
        success: false,
        message: data.message || 'Failed to initialize session'
      };
    }
  } catch (error) {
    return {
      success: false,
      message: `Session init error: ${error.message}`
    };
  }
}

/**
 * Проверка лицензионного ключа через KeyAuth API
 * @param {string} licenseKey - Ключ из config.json
 * @returns {Promise<{success: boolean, message: string, data?: any}>}
 */
async function verifyLicense(licenseKey) {
  // Проверяем что конфигурация заполнена
  if (!KEYAUTH_CONFIG.appName || !KEYAUTH_CONFIG.ownerId || !KEYAUTH_CONFIG.appSecret) {
    return {
      success: false,
      message: 'KeyAuth configuration not set. Please configure appName, ownerId and appSecret in license-check.js'
    };
  }

  // Проверяем наличие ключа
  if (!licenseKey || licenseKey.trim() === '') {
    return {
      success: false,
      message: 'License key not found. Please add "license_key" to your config.json file.'
    };
  }

  // Шаг 1: Инициализируем сессию (получаем sessionid)
  const sessionResult = await initSession();
  if (!sessionResult.success) {
    return {
      success: false,
      message: `Failed to initialize KeyAuth session: ${sessionResult.message}`
    };
  }

  const sessionid = sessionResult.sessionid;
  const hwid = generateHWID();
  
  try {
    // Шаг 2: Проверяем лицензию с sessionid
    const response = await axios.post('https://keyauth.win/api/1.2/', {
      type: 'license',
      key: licenseKey.trim(),
      hwid: hwid,
      sessionid: sessionid,
      name: KEYAUTH_CONFIG.appName,
      ownerid: KEYAUTH_CONFIG.ownerId,
      secret: KEYAUTH_CONFIG.appSecret,
      version: KEYAUTH_CONFIG.version
    }, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: 15000
    });

    const data = response.data;

    if (data.success) {
      return {
        success: true,
        message: 'License verified successfully!',
        data: {
          username: data.info?.username || 'Unknown',
          expiry: data.info?.subscriptions?.[0]?.expiry || 'Unknown',
          hwid: hwid
        }
      };
    } else {
      // Обработка специфических ошибок KeyAuth
      let errorMessage = data.message || 'Unknown error';
      
      if (errorMessage.toLowerCase().includes('hwid')) {
        errorMessage = `HWID mismatch! Your key is bound to another device. Contact support to reset HWID.\nYour HWID: ${hwid}`;
      } else if (errorMessage.toLowerCase().includes('expired')) {
        errorMessage = 'Your license key has expired. Please renew your subscription.';
      } else if (errorMessage.toLowerCase().includes('invalid') || errorMessage.toLowerCase().includes('not found')) {
        errorMessage = 'Invalid license key. Please check your key and try again.';
      }

      return {
        success: false,
        message: errorMessage
      };
    }
  } catch (error) {
    if (error.code === 'ECONNABORTED') {
      return {
        success: false,
        message: 'Connection timeout. Please check your internet connection.'
      };
    }
    
    if (error.response) {
      return {
        success: false,
        message: `Server error: ${error.response.status} - ${error.response.statusText}`
      };
    }

    return {
      success: false,
      message: `Network error: ${error.message}. Please check your internet connection.`
    };
  }
}

/**
 * Красивая печать баннера лицензии
 */
function printLicenseBanner(result) {
  console.log('\n' + colors.cyan + '╔════════════════════════════════════════════════════════╗' + colors.reset);
  console.log(colors.cyan + '║' + colors.reset + '           AI Bot - License Verification              ' + colors.cyan + '║' + colors.reset);
  console.log(colors.cyan + '╠════════════════════════════════════════════════════════╣' + colors.reset);
  
  if (result.success) {
    console.log(colors.cyan + '║' + colors.green + '  ✅ License: VERIFIED                                 ' + colors.cyan + '║' + colors.reset);
    console.log(colors.cyan + '║' + colors.reset + `  👤 User: ${(result.data?.username || 'N/A').padEnd(35)}` + colors.cyan + '║' + colors.reset);
    console.log(colors.cyan + '║' + colors.reset + `  🔑 HWID: ${(result.data?.hwid?.substring(0, 16) + '...').padEnd(35)}` + colors.cyan + '║' + colors.reset);
    console.log(colors.cyan + '╚════════════════════════════════════════════════════════╝' + colors.reset);
    console.log(colors.green + '\n✓ License verification passed. Starting bot...\n' + colors.reset);
  } else {
    console.log(colors.cyan + '║' + colors.red + '  ❌ License: FAILED                                    ' + colors.cyan + '║' + colors.reset);
    console.log(colors.cyan + '║' + colors.reset + `  📝 Error: ${(result.message.substring(0, 37) || 'Unknown').padEnd(37)}` + colors.cyan + '║' + colors.reset);
    console.log(colors.cyan + '╚════════════════════════════════════════════════════════╝' + colors.reset);
    console.log(colors.red + '\n✗ License verification failed.\n' + colors.reset);
  }
}

/**
 * Главная функция проверки лицензии
 */
async function checkLicense(configPath = './config.json') {
  try {
    // Проверяем существование config.json
    const fullPath = path.resolve(configPath);
    if (!fs.existsSync(fullPath)) {
      printLicenseBanner({
        success: false,
        message: `Config file not found: ${configPath}. Please create config.json with your license key.`
      });
      return false;
    }

    // Читаем config.json
    const configData = fs.readFileSync(fullPath, 'utf8');
    const config = JSON.parse(configData);

    if (!config.license_key) {
      printLicenseBanner({
        success: false,
        message: 'license_key not found in config.json. Please add your license key.'
      });
      return false;
    }

    // Проверяем лицензию
    const result = await verifyLicense(config.license_key);
    printLicenseBanner(result);
    
    return result.success;
  } catch (error) {
    printLicenseBanner({
      success: false,
      message: `Error reading config: ${error.message}`
    });
    return false;
  }
}

module.exports = {
  checkLicense,
  verifyLicense,
  initSession,
  generateHWID,
  KEYAUTH_CONFIG
};

// Если запущено напрямую (для тестирования)
if (require.main === module) {
  checkLicense().then(valid => {
    process.exit(valid ? 0 : 1);
  });
}
