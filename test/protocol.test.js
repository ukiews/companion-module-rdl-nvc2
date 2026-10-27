const { test } = require('node:test')
const assert = require('node:assert/strict')
const { parseResponse, parseResponses, setLevel, selectProfile, buildV2 } = require('../src/protocol')
test('Config selection uses V2 zone set, not the display menu command', () => {
	assert.equal(selectProfile(2).toString('hex'), '56320100000000000019000000000000000000000500000501')
	assert.equal(buildV2(0x0501).toString('hex'), '563201000000000000180000000000000000000005010004')
	for (let profile = 1; profile <= 4; profile++) assert.equal(selectProfile(profile)[24], profile - 1)
	for (let screen = 0; screen < 4; screen++) assert.equal(parseResponse(Buffer.from(`ACKDISP${screen}`)), null)
	for (const invalid of [0, 5, NaN, 1.5]) assert.throws(() => selectProfile(invalid))
})
test('Decode captured V2 profile readback separately from a setter acknowledgment', () => {
	const query = Buffer.from('56320100000000000019000000000000000000008501000500', 'hex')
	assert.deepEqual(parseResponses(query), [{ type: 'profile', source: 'query', profile: 1 }])
	const set = Buffer.from('56320100000000000019000000000000000000008500000501', 'hex')
	assert.deepEqual(parseResponses(set), [{ type: 'profile', source: 'set', profile: 2 }])
	for (let length = 0; length < query.length; length++) assert.deepEqual(parseResponses(query.subarray(0, length)), [])
	for (const [position, value] of [
		[9, 24],
		[2, 2],
		[23, 0],
		[24, 4],
	]) {
		const invalid = Buffer.from(query)
		invalid[position] = value
		assert.deepEqual(parseResponses(invalid), [])
	}
})
test('Decode multiple V2 frames without accepting a truncated trailing frame', () => {
	const packet = Buffer.from('5632020000000000001e0000000000000000000085000005018501000501', 'hex')
	assert.deepEqual(parseResponses(packet), [
		{ type: 'profile', source: 'set', profile: 2 },
		{ type: 'profile', source: 'query', profile: 2 },
	])
	const invalid = Buffer.from(packet)
	invalid[28] = 20
	assert.deepEqual(parseResponses(invalid), [])
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
