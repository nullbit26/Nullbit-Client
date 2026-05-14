'use strict'

const path = require('path')
const ConfigManager = require('./config/ConfigManager')

ConfigManager.load({ envPath: path.join(__dirname, '.env') })

const { start } = require('./startBot')
start()
