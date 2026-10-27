const { test } = require('node:test')
const assert = require('node:assert/strict')
const { VolumeControl } = require('../src/control')
function fixture({ initial = 1, ignoresWrite = false, losesAck = false } = {}) {
	let profile = initial
	const writes = []
	const client = {
		serial: (fn) => fn(),
		queryProfile: async () => ({ type: 'profile', source: 'query', profile }),
		async request(command, match) {
			assert.ok(Buffer.isBuffer(command))
			assert.equal(command.readUInt16BE(20), 0x0500)
			writes.push(command)
			if (!ignoresWrite) profile = command[24] + 1
			if (losesAck) throw new Error('Timeout waiting for V2 0x0500')
			const ack = { type: 'profile', source: 'set', profile: command[24] + 1 }
			assert.equal(match(ack), true)
			assert.equal(match({ type: 'profile', source: 'query', profile: ack.profile }), false)
			return ack
		},
	}
	return { control: new VolumeControl(client), writes }
}
test('Profile success requires independently queried state after writing', async () => {
	const { control } = fixture()
	assert.deepEqual(await control.selectProfile(2), { type: 'profile', source: 'query', profile: 2 })
})
test('Acknowledgment without the desired state is a failure', async () => {
	const { control } = fixture({ ignoresWrite: true })
	await assert.rejects(control.selectProfile(2), /readback mismatch/)
})
test('Selecting the current profile is idempotent and sends no setter', async () => {
	const { control, writes } = fixture({ initial: 2 })
	assert.equal((await control.selectProfile(2)).profile, 2)
	assert.deepEqual(writes, [])
})
test('Lost ACK is recovered only if readback confirms the requested state', async () => {
	assert.equal((await fixture({ losesAck: true }).control.selectProfile(2)).profile, 2)
	await assert.rejects(fixture({ losesAck: true, ignoresWrite: true }).control.selectProfile(2), /Timeout/)
})
