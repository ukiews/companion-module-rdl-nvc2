const { test } = require('node:test')
const assert = require('node:assert/strict')
const { VolumeControl } = require('../src/control')
function fixture(levels = [31, 32]) {
	const writes = []
	let tail = Promise.resolve()
	const client = {
		serial(fn) {
			const result = tail.then(fn)
			tail = result.catch(() => {})
			return result
		},
		async queryLevels() {
			return { levels: [...levels] }
		},
		async request(cmd) {
			writes.push(cmd)
			levels[Number(cmd[2])] = Number(cmd.slice(3))
			return {}
		},
	}
	return { control: new VolumeControl(client), levels, writes }
}
test('Mute restores each channel independently and repeated mute preserves saved volume', async () => {
	const { control, levels } = fixture()
	await control.execute('mute', 'both')
	assert.deepEqual(levels, [64, 64])
	await control.execute('mute', 'both')
	await control.execute('unmute', 'both')
	assert.deepEqual(levels, [31, 32])
})
test('Unknown restore levels fail before either output is written', async () => {
	const { control, writes } = fixture([31, 64])
	await assert.rejects(control.execute('unmute', 'both'), /No saved level/)
	assert.deepEqual(writes, [])
})
test('Positive volume changes reduce attenuation; clamp and preserve muted outputs', async () => {
	const { control, levels } = fixture([1, 64])
	await control.execute('adjust', 'both', 5)
	assert.deepEqual(levels, [0, 64])
	await control.execute('adjust', 'both', -63)
	assert.deepEqual(levels, [63, 64])
})
test('Mixed toggle mutes both then restores both', async () => {
	const { control, levels } = fixture()
	await control.execute('mute', '0')
	await control.execute('toggle', 'both')
	assert.deepEqual(levels, [64, 64])
	await control.execute('toggle', 'both')
	assert.deepEqual(levels, [31, 32])
})
test('Rapid concurrent presses serialize read-modify-write operations', async () => {
	const { control, levels } = fixture()
	await Promise.all(Array.from({ length: 10 }, () => control.execute('adjust', 'both', 1)))
	assert.deepEqual(levels, [21, 22])
})
test('Reject invalid actions and values without writes', async () => {
	const { control, writes } = fixture()
	for (const args of [
		['set', 'both', 64],
		['set', 'both', NaN],
		['adjust', 'both', 0.5],
		['set', 'x', 20],
		['unknown', 'both'],
	])
		await assert.rejects(control.execute(...args))
	assert.deepEqual(writes, [])
})
