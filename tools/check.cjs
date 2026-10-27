// The upstream tools 3.0.2 check CLI mishandles file URLs on Windows.
const fs = require('node:fs')
const { validateManifest } = require('@companion-module/base/manifest')
validateManifest(JSON.parse(fs.readFileSync('companion/manifest.json', 'utf8')), false)
console.log('Companion manifest valid')
