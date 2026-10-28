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
	return { control: new VolumeControl(client), client, levels, writes }
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

test('Explicit Set supersedes an earlier mute restore target', async () => {
	const { control, levels } = fixture([5, 32])
	await control.execute('mute', '0')
	await control.execute('set', '0', 60)
	levels[0] = 64 // A later physical/Console mute has no module-owned restore target.
	await assert.rejects(control.execute('unmute', '0'), /No saved level/)
	assert.equal(levels[0], 64)
})

test('Unmute consumes its snapshot; observed external unmute also invalidates it', async () => {
	const { control, levels } = fixture()
	await control.execute('mute', '0')
	await control.execute('unmute', '0')
	assert.deepEqual(control.saved, [null, null])
	await control.execute('mute', '0')
	control.observeLevels([60, 32])
	levels[0] = 64
	await assert.rejects(control.execute('unmute', '0'), /No saved level/)
})

test('A stale level observation during our mute write does not discard its snapshot', async () => {
	const { control, client } = fixture()
	const request = client.request.bind(client)
	client.request = async (command) => {
		control.observeLevels([31, 32])
		return request(command)
	}
	await control.execute('mute', '0')
	assert.deepEqual(control.saved, [31, null])
})

test('Desired ACK without matching final levels is rejected', async () => {
	const { control, client } = fixture()
	client.request = async () => ({ type: 'set', channel: 0, attenuation: 10 })
	await assert.rejects(control.execute('set', '0', 10), /Level readback mismatch/)
})

test('Lost setter ACK is reconciled from actual level without another write', async () => {
	const { control, client, writes, levels } = fixture()
	const request = client.request.bind(client)
	client.request = async (command) => {
		await request(command)
		throw new Error('Timeout waiting for setter')
	}
	await control.execute('set', '0', 10)
	assert.deepEqual(writes, ['SL010'])
	assert.equal(levels[0], 10)
})

test('Unapplied mute after ACK timeout loses its unconfirmed restore target', async () => {
	const { control, client, levels } = fixture()
	client.request = async () => {
		throw new Error('Timeout waiting for setter')
	}
	await assert.rejects(control.execute('mute', '0'), /Timeout waiting/)
	assert.deepEqual(control.saved, [null, null])
	assert.equal(levels[0], 31)
})

test('Partial linked mute retains only the channel confirmed muted', async () => {
	const { control, client, levels } = fixture()
	const request = client.request.bind(client)
	client.request = async (command) => {
		if (command === 'SL164') throw new Error('Timeout waiting for setter')
		return request(command)
	}
	await assert.rejects(control.execute('mute', 'both'), /Timeout waiting/)
	assert.deepEqual(levels, [64, 32])
	assert.deepEqual(control.saved, [31, null])
	await control.execute('unmute', '0')
	assert.deepEqual(levels, [31, 32])
})

test('Connection invalidation during a pending mute cannot resurrect restore state', async () => {
	const { control, client } = fixture()
	let entered, release
	const started = new Promise((resolve) => {
		entered = resolve
	})
	const gate = new Promise((resolve) => {
		release = resolve
	})
	const request = client.request.bind(client)
	client.request = async (command) => {
		await request(command)
		entered()
		await gate
	}
	const action = control.execute('mute', '0')
	await started
	control.clearRestore()
	release()
	await assert.rejects(action, { code: 'RDL_ACTION_CANCELLED' })
	assert.deepEqual(control.saved, [null, null])
})

test('A relative adjustment that expires during its level query sends no setter', async () => {
	const { control, client, writes } = fixture()
	const originalNow = Date.now
	let now = 1000
	Date.now = () => now
	const query = client.queryLevels.bind(client)
	client.queryLevels = async () => {
		now += 1001
		return query()
	}
	try {
		await assert.rejects(control.execute('adjust', '0', 1), { code: 'RDL_ACTION_EXPIRED' })
		assert.deepEqual(writes, [])
	} finally {
		Date.now = originalNow
	}
})

test('A fresh linked adjustment completes both writes if ACK latency crosses its deadline', async () => {
	const { control, client, levels } = fixture()
	const originalNow = Date.now
	let now = 1000
	Date.now = () => now
	const request = client.request.bind(client)
	client.request = async (command) => {
		now += 1500
		return request(command)
	}
	try {
		await control.execute('adjust', 'both', 1)
		assert.deepEqual(levels, [30, 31])
	} finally {
		Date.now = originalNow
	}
})
