const { test } = require('node:test')
const assert = require('node:assert/strict')
const { RdlClient } = require('../src/client')
function fixture() {
	const client = new RdlClient({ host: '192.0.2.1', timeout: 10 })
	client.ready = true
	client.socket = {
		send(buffer, port, host, callback) {
			callback()
		},
		close() {},
	}
	return client
}
test('Lost replies retry once, then fail and clean up', async () => {
	const client = fixture()
	let sends = 0
	client.socket.send = (buffer, port, host, callback) => {
		sends++
		callback()
	}
	await assert.rejects(client.queryLevels(), /Timeout/)
	assert.equal(sends, 2)
	assert.equal(client.pending.size, 0)
	client.close()
})
test('Close cancels an outstanding request and prevents queued writes', async () => {
	const client = fixture()
	const request = client.queryLevels()
	client.close()
	await assert.rejects(request, /closed/)
	await assert.rejects(
		client.serial(() => assert.fail('Must not run')),
		/closed/,
	)
	assert.equal(client.pending.size, 0)
})
test('Matching NAK immediately rejects instead of claiming success', async () => {
	const client = fixture()
	const request = client.queryLevels()
	const pending = [...client.pending][0]
	assert.equal(pending.match({ type: 'nak', command: 'QC' }), false)
	const response = { type: 'nak', command: 'QL' }
	assert.equal(pending.match(response), true)
	pending.finish(null, response)
	await assert.rejects(request, /Device rejected QL/)
	client.close()
})
