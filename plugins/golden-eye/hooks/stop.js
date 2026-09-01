#!/usr/bin/env node
'use strict';
const { logStdinEvent } = require('./lib/logger');
logStdinEvent('Stop').then(() => process.exit(0), () => process.exit(0));