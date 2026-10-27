const { test } = require('node:test')
const assert = require('node:assert/strict')
const { parseResponse, setLevel, selectProfile } = require('../src/protocol')
test('Console Config selection uses zero-based ASCII DISP commands', () => {
	for (let profile = 1; profile <= 4; profile++) {
		assert.equal(selectProfile(profile), `DISP${profile - 1}`)
		assert.deepEqual(parseResponse(Buffer.from(`ACKDISP${profile - 1}`)), { type: 'profile', profile })
	}
	for (const invalid of [0, 5, NaN, 1.5]) assert.throws(() => selectProfile(invalid))
})
test('Documented QL examples and live NVC2 capabilities', () => {
	assert.deepEqual(parseResponse(Buffer.from('ACKQLC1-031C2-064')), { type: 'levels', levels: [31, 64] })
	assert.deepEqual(parseResponse(Buffer.from('ACKQCD-NVC2:V0.1.27:CHI2O2:OC(YYNN)')), {
		type: 'capabilities',
		model: 'D-NVC2',
		firmware: '0.1.27',
		outputs: 2,
	})
	assert.deepEqual(parseResponse(Buffer.from('NAKSL164')), { type: 'nak', command: 'SL164' })
	assert.deepEqual(parseResponse(Buffer.from('ACKSL164')), { type: 'set', channel: 1, attenuation: 64 })
})
test('Reject truncated, malformed and unrelated replies', () => {
	for (const message of [
		'ACKQL',
		'ACKQLC1-031',
		'ACKQLC1-031C2-abc',
		'ACKQLC1-031C2-020junk',
		'ACKQGC13C25',
		'garbage',
	])
		assert.equal(parseResponse(Buffer.from(message)), null, message)
})
test('Channel addressing and ASCII zero padding', () => {
	assert.equal(setLevel(0, 0), 'SL000')
	assert.equal(setLevel(1, 9), 'SL109')
	assert.equal(setLevel(1, 64), 'SL164')
	for (const args of [
		[2, 10],
		[0, -1],
		[0, 65],
		[0, 1.5],
		[0, NaN],
	])
		assert.throws(() => setLevel(...args))
})
