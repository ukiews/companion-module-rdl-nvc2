const { test } = require('node:test')
const assert = require('node:assert/strict')
const { VolumeControl } = require('../src/control')

function fixture({ initial = false, ignoresWrite = false, losesAck = false } = {}) {
	let enabled = initial
	const calls = []
	const control = new VolumeControl({
		serial: (fn) => fn(),
		async queryVolumeLock() {
			calls.push('query')
			return { type: 'volumeLock', source: 'query', enabled }
		},
		async request(command, match) {
			const desired = command[28] === 1
			calls.push(desired)
			if (!ignoresWrite) enabled = desired
			if (losesAck) throw new Error('Timeout waiting for V2 0x0105')
			const ack = { type: 'volumeLock', source: 'set', enabled: desired }
			assert.equal(match(ack), true)
			assert.equal(match({ ...ack, enabled: !desired }), false)
			assert.equal(match({ ...ack, source: 'query' }), false)
			return ack
		},
	})
	return { control, calls }
}

test('Enabling and disabling volume lock each require independent readback', async () => {
	const { control, calls } = fixture()
	assert.equal((await control.setVolumeLock(true)).enabled, true)
	assert.equal((await control.setVolumeLock(false)).enabled, false)
	assert.deepEqual(calls, ['query', true, 'query', 'query', false, 'query'])
})

test('Unsupported devices and no-op volume lock changes do not get a property write', async () => {
	const unsupported = fixture({ initial: null })
	await assert.rejects(unsupported.control.setVolumeLock(true), /does not report support/)
	assert.deepEqual(unsupported.calls, ['query'])
	const unchanged = fixture({ initial: true })
	assert.equal((await unchanged.control.setVolumeLock(true)).enabled, true)
	assert.deepEqual(unchanged.calls, ['query'])
})

test('Volume lock readback detects ignored writes even when the request is acknowledged', async () => {
	await assert.rejects(fixture({ ignoresWrite: true }).control.setVolumeLock(true), /did not confirm/)
	assert.equal((await fixture({ losesAck: true }).control.setVolumeLock(true)).enabled, true)
	await assert.rejects(fixture({ ignoresWrite: true, losesAck: true }).control.setVolumeLock(true), /Timeout/)
})
