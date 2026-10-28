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
function deferred() {
	let resolve
	const promise = new Promise((r) => {
		resolve = r
	})
	return { promise, resolve }
}
async function holdQueue(client) {
	const entered = deferred(),
		release = deferred()
	const head = client.serial(async () => {
		entered.resolve()
		await release.promise
	})
	await entered.promise
	return { head, release: release.resolve }
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

test('Actions overtake queued polling without changing state-action order', async () => {
	const client = fixture(),
		held = await holdQueue(client),
		events = []
	const poll = client.serial(() => events.push('poll'), { kind: 'poll' })
	const profile = client.serial(() => events.push('profile'))
	const adjust = client.serial(() => events.push('adjust'), { kind: 'adjust', maxAge: 1000 })
	const set = client.serial(() => events.push('set'))
	held.release()
	await Promise.all([held.head, poll, profile, adjust, set])
	assert.deepEqual(events, ['profile', 'adjust', 'set', 'poll'])
	client.close()
})

test('Queue admits at most 32 waiting actions and rejects overflow', async () => {
	const client = fixture(),
		held = await holdQueue(client),
		events = []
	const actions = Array.from({ length: 32 }, (_, index) => client.serial(() => events.push(index)))
	await assert.rejects(
		client.serial(() => assert.fail('Overflow must not run')),
		{ code: 'RDL_QUEUE_FULL' },
	)
	assert.equal(client.queue.length, 32)
	held.release()
	await Promise.all([held.head, ...actions])
	assert.deepEqual(
		events,
		Array.from({ length: 32 }, (_, index) => index),
	)
	client.close()
})

test('An action can replace a queued background poll when the queue is full', async () => {
	const client = fixture(),
		held = await holdQueue(client),
		events = []
	const poll = client.serial(() => assert.fail('Evicted poll must not run'), { kind: 'poll' })
	const skipped = assert.rejects(poll, { code: 'RDL_ACTION_CANCELLED' })
	const actions = Array.from({ length: 31 }, (_, index) => client.serial(() => events.push(index)))
	const last = client.serial(() => events.push(31))
	assert.equal(client.queue.length, 32)
	held.release()
	await Promise.all([held.head, skipped, last, ...actions])
	assert.equal(events.length, 32)
	client.close()
})

test('Mute cancels queued adjustments, preserves other actions, and leaves the active operation alone', async () => {
	const client = fixture(),
		entered = deferred(),
		release = deferred(),
		events = []
	const active = client.serial(
		async () => {
			events.push('active')
			entered.resolve()
			await release.promise
		},
		{ kind: 'adjust' },
	)
	await entered.promise
	const before = client.serial(() => events.push('profile'))
	const oldAdjust = client.serial(() => assert.fail('Stale adjustment must not run'), { kind: 'adjust' })
	const cancelled = assert.rejects(oldAdjust, { code: 'RDL_ACTION_CANCELLED' })
	const set = client.serial(() => events.push('set'))
	const mute = client.serial(() => events.push('mute'), { kind: 'mute' })
	assert.deepEqual(events, ['active'])
	release.resolve()
	await Promise.all([active, before, cancelled, set, mute])
	assert.deepEqual(events, ['active', 'profile', 'set', 'mute'])
	client.close()
})

test('Expired queued adjustments are skipped and later actions still run', async () => {
	const client = fixture(),
		held = await holdQueue(client),
		events = []
	const adjust = client.serial(() => assert.fail('Expired adjustment must not run'), { kind: 'adjust', maxAge: 5 })
	const expired = assert.rejects(adjust, { code: 'RDL_ACTION_EXPIRED' })
	const next = client.serial(() => events.push('next'))
	await new Promise((resolve) => setTimeout(resolve, 15))
	held.release()
	await Promise.all([held.head, expired, next])
	assert.deepEqual(events, ['next'])
	client.close()
})

test('Request timeout discards queued adjustments while retaining explicit actions', async () => {
	const client = fixture(),
		events = []
	const polling = client.serial(() => client.queryLevels(), { kind: 'poll' })
	const failedPoll = assert.rejects(polling, /Timeout/)
	await new Promise((resolve) => setImmediate(resolve))
	const adjust = client.serial(() => assert.fail('Timed-out adjustment must not replay'), { kind: 'adjust' })
	const cancelled = assert.rejects(adjust, { code: 'RDL_ACTION_CANCELLED' })
	const action = client.serial(() => events.push('set'))
	await Promise.all([failedPoll, cancelled, action])
	assert.deepEqual(events, ['set'])
	client.close()
})

test('Close immediately rejects active and queued work and cancels its request', async () => {
	const client = fixture()
	const active = client.serial(() => client.queryLevels())
	const activeClosed = assert.rejects(active, /closed/)
	await new Promise((resolve) => setImmediate(resolve))
	const queued = client.serial(() => assert.fail('Queued write must not run'))
	const queuedClosed = assert.rejects(queued, /closed/)
	client.close()
	await Promise.all([activeClosed, queuedClosed])
	assert.equal(client.pending.size, 0)
	assert.equal(client.queue.length, 0)
})

test('Close between scheduling and invocation prevents the operation from starting', async () => {
	const client = fixture()
	const action = client.serial(() => assert.fail('Closed operation must not start'))
	const rejected = assert.rejects(action, /closed/)
	await Promise.resolve() // Allow the drain to select an active entry before invocation.
	client.close()
	await rejected
})

test('Maintenance pause stops pending requests and queued writes without closing reception', async () => {
	const client = fixture()
	let closes = 0,
		sends = 0
	client.socket.close = () => {
		closes++
	}
	client.socket.send = (buffer, port, host, callback) => {
		sends++
		callback()
	}
	const active = client.serial(() => client.queryLevels())
	const pausedActive = assert.rejects(active, { code: 'RDL_MAINTENANCE' })
	await new Promise((resolve) => setImmediate(resolve))
	const queued = client.serial(() => assert.fail('Maintenance must discard queued writes'))
	const pausedQueued = assert.rejects(queued, { code: 'RDL_MAINTENANCE' })
	client.setPaused(true)
	await Promise.all([pausedActive, pausedQueued])
	assert.equal(client.pending.size, 0)
	assert.equal(client.queue.length, 0)
	assert.equal(closes, 0)
	assert.equal(client.ready, true)
	await assert.rejects(client.queryLevels(), { code: 'RDL_MAINTENANCE' })
	await assert.rejects(
		client.serial(() => assert.fail('Paused action must not run')),
		{ code: 'RDL_MAINTENANCE' },
	)
	assert.equal(sends, 1, 'Paused commands must not be sent or retried')
	client.close()
})

test('Capabilities query can finish during maintenance and an explicit probe can resume work', async () => {
	const client = fixture()
	const initialQc = client.queryCapabilities()
	client.setPaused(true)
	const qc = [...client.pending][0]
	assert.equal(qc.command, 'QC')
	qc.finish(null, { type: 'capabilities', model: 'H743VI-UTX-BOOTLOADER', firmware: '0.1.5' })
	assert.equal((await initialQc).model, 'H743VI-UTX-BOOTLOADER')
	const probe = client.serial(() => client.queryCapabilities(), { kind: 'maintenance' })
	await new Promise((resolve) => setImmediate(resolve))
	assert.equal(client.pending.size, 1)
	;[...client.pending][0].finish(null, { type: 'capabilities', model: 'D-NVC2', firmware: '0.1.30' })
	assert.equal((await probe).model, 'D-NVC2')
	client.setPaused(false)
	assert.equal(await client.serial(() => 'resumed'), 'resumed')
	client.close()
})

test('Maintenance pause between selection and invocation prevents a write from starting', async () => {
	const client = fixture()
	const action = client.serial(() => assert.fail('Paused operation must not start'))
	const rejected = assert.rejects(action, { code: 'RDL_MAINTENANCE' })
	await Promise.resolve()
	client.setPaused(true)
	await rejected
	client.close()
})

test('Maintenance pause after a timeout settles prevents its scheduled retry', async () => {
	const client = fixture()
	let sends = 0
	client.socket.send = (buffer, port, host, callback) => {
		sends++
		callback()
	}
	const request = client.queryLevels()
	const rejected = assert.rejects(request, { code: 'RDL_MAINTENANCE' })
	// The timeout has rejected the first attempt, but its catch microtask has
	// not executed yet. There is no pending request left for pause to cancel.
	;[...client.pending][0].finish(new Error('Timeout waiting for QL'))
	assert.equal(client.pending.size, 0)
	client.setPaused(true)
	await rejected
	assert.equal(sends, 1)
	assert.equal(client.pending.size, 0)
	client.close()
})
