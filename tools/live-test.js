// Explicitly invoked commissioning test. Never runs as part of npm/pnpm test.
const assert = require('node:assert/strict')
const { RdlClient } = require('../src/client')
const { VolumeControl } = require('../src/control')
const { setLevel } = require('../src/protocol')
async function main() {
	const host = process.argv[2]
	if (!host) throw new Error('Usage: node tools/live-test.js DEVICE_IP [LOCAL_INTERFACE_IP]')
	const client = new RdlClient({ host, localAddress: process.argv[3] || '' })
	client.on('fault', (error) => console.error(error.message))
	client.on('warning', console.warn)
	let original
	const results = []
	async function expect(label, operation, expected) {
		const response = await operation()
		assert.deepEqual(response.levels, expected, label)
		results.push({ test: label, levels: response.levels })
		console.log(`PASS ${label}: ${response.levels.join(', ')}`)
	}
	try {
		await client.open()
		console.log('Capabilities:', await client.queryCapabilities())
		original = (await client.queryLevels()).levels
		console.log('Original attenuation:', original)
		const control = new VolumeControl(client)
		// Config 1 was selected in Console before commissioning. Caller must explicitly
		// supply the original profile to enable profile tests and restore it afterward.
		if (process.argv[4]) {
			for (const profile of [1, 2, 3, 4, 2, 3, 1]) {
				const response = await control.selectProfile(profile)
				assert.equal(response.profile, profile)
				console.log(`PASS select Config ${profile}: device acknowledged`)
			}
		}
		await expect('Set both channels', () => control.execute('set', 'both', 40), [40, 40])
		await expect('Set A only', () => control.execute('set', '0', 41), [41, 40])
		await expect('Set B only', () => control.execute('set', '1', 42), [41, 42])
		await expect('Volume up both', () => control.execute('adjust', 'both', 1), [40, 41])
		await expect('Volume down both', () => control.execute('adjust', 'both', -2), [42, 43])
		await expect('Mute A', () => control.execute('mute', '0'), [64, 43])
		await expect('Adjustment preserves mute', () => control.execute('adjust', '0', 1), [64, 43])
		await expect('Restore A', () => control.execute('unmute', '0'), [42, 43])
		await expect('Mute both', () => control.execute('mute', 'both'), [64, 64])
		await expect('Restore both', () => control.execute('unmute', 'both'), [42, 43])
		await expect('Toggle both to mute', () => control.execute('toggle', 'both'), [64, 64])
		await expect('Toggle both to restore', () => control.execute('toggle', 'both'), [42, 43])
		await expect('63 dB boundary', () => control.execute('set', 'both', 63), [63, 63])
		await expect('64 dB mute boundary', () => control.execute('mute', 'both'), [64, 64])
		await expect('Restore from mute boundary', () => control.execute('unmute', 'both'), [63, 63])
	} finally {
		if (original) {
			const failures = []
			for (let c = 0; c < 2; c++) {
				try {
					const cmd = setLevel(c, Math.min(64, original[c]))
					await client.request(
						cmd,
						(r) => r.type === 'set' && r.channel === c && r.attenuation === Math.min(64, original[c]),
					)
				} catch (error) {
					failures.push(error.message)
				}
			}
			try {
				const restored = (await client.queryLevels()).levels
				assert.deepEqual(restored, original)
				console.log('RESTORED:', restored)
			} catch (error) {
				failures.push(error.message)
			}
			if (failures.length) {
				console.error('RESTORE FAILED:', failures)
				process.exitCode = 1
			}
		}
		if (process.argv[4]) {
			try {
				const profile = Number(process.argv[4])
				await new VolumeControl(client).selectProfile(profile)
				console.log('RESTORED Config', profile)
			} catch (error) {
				console.error('PROFILE RESTORE FAILED:', error.message)
				process.exitCode = 1
			}
		}
		client.close()
	}
}
main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
