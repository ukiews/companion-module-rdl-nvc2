# RDL D-NVC2 for Bitfocus Companion

Control an RDL D-NVC2 over its control network: independent or linked output attenuation, volume up/down, mute/restore, saved Config selection, live variables, and button feedback. Hardware validation covers D-NVC2 firmware 0.1.27 and the custom display build based on 0.1.30. DB-NVC2 and DS-NVC2 are listed as enclosure variants; they were not separately tested.

## Install

Requires Companion 5 or newer with the Node 22 module runtime and module API 2 support. Download `rdl-nvc2-1.0.6.tgz` from the [module release](https://github.com/ukiews/companion-module-rdl-nvc2/releases/tag/v1.0.6), open Companion's **Modules** page, and use **Import module package**. Add the **RDL D-NVC2** connection, enter your device's IPv4 address, and drag buttons from **Presets** to your page. For an existing connection, select module version 1.0.6 after importing. This is a custom module; it is not yet in the Bitfocus module catalog.

On a computer with several network interfaces, select the IPv4 address of the local interface connected to the device. Leaving the interface blank joins multicast on every available IPv4 interface. The device address and local interface address are different settings.

## Network

Commands go to the device on UDP 18700. By default, replies arrive on UDP 9000, either at multicast group `239.254.50.0` or directly at the Companion host if unicast responses are enabled on the knob. Allow inbound UDP replies through the host firewall. For multicast responses, the device and Companion must be able to reach the multicast group. Enter a different multicast group or response port in the connection if the device is already configured to use it.

Only replies whose source IPv4 matches the configured device are processed. Multiple unicast knobs can share a response port on Linux. On other hosts, use multicast or separate response ports for multiple knobs. Prefer one Companion connection per device, because concurrent controllers can still interleave changes. Each request retries once on timeout. Socket failures reopen automatically with a retry delay capped at 10 seconds; three consecutive failed level polls also reopen the socket. UDP acknowledgments have no transaction IDs, so simultaneous external control cannot be made atomic.

The default polling interval is one second after the previous poll completes, configurable from 500 to 10,000 ms. A healthy cycle queries levels and the active Config; capabilities are queried at startup and after a connection failure. The startup poll and subsequent polls about 30 seconds apart also read Config names and the physical volume lock setting. Unchanged replies do not republish variables or reevaluate button feedback. There are no additional background scan timers or runtime dependencies.

The action queue holds at most 32 waiting operations. Volume adjustments expire after one second and waiting adjustments are discarded on a request timeout or a subsequent Mute/Toggle action. Actions take priority over waiting polls, while explicit state changes retain their order. An operation already in progress must finish or time out before the next one can run.

Disable the connection before updating device firmware. If the module receives a bootloader identity, it pauses polling and controls automatically. After the update, use **Refresh device status** to check the device identity and resume, or disable and re-enable the connection. Automatic detection is not a substitute for disabling the connection before an update.

## Volume and mute

- Channel A is Output 1; B is Output 2. Commands can target either or both.
- **Set attenuation** accepts 0–63 dB of attenuation or 0–100% volume. In dB mode, 0 dB is full volume and larger values are quieter. In percent mode, 0% mutes and remembers the previous level for Restore. 1% is the quietest unmuted level (63 dB attenuation), and 100% is full volume. Intermediate values follow the custom display scale, rounded to the nearest 1 dB step.
- Adjust volume uses positive values for louder and negative values for quieter. Adjustments clamp at 0/63 and leave muted channels muted.
- Mute uses 64. Hardware reports 63 and 64 distinctly, unlike the older RN-family documentation's generalized mute range.
- Restore returns each channel to its level before a module-issued mute. Each saved level is consumed by restore and cleared by an explicit Set or an observed external unmute. All saved levels are cleared on connection failure, restart/reconfiguration, or a detected bootloader. If a muted channel has no saved level, explicitly use Set attenuation; the module refuses to guess a restore level.
- Linked toggle mutes both if either is unmuted; it restores both if both are muted. Individual channel levels are preserved.
- The module queries current levels before volume changes and verifies changed channels with readback after writes. A lost setter acknowledgment is accepted only if readback confirms the requested level. Levels from physical knob changes appear on subsequent polls. Linked writes occur sequentially, so a failure can leave one channel changed; the module logs the error and subsequent polls show actual device state.

## Saved RDL Config profiles

The **Select saved RDL Config profile** action and four presets select Config 1–4 already stored in RDL Console. These are the knob's saved channel configurations; this action does not create or modify profiles or store/recall a pair of volume values. Configure names, channel assignments, and enable flags in RDL Console.

The Config selector displays device-reported names in parentheses, such as **Config 3 (GMeet)**. Slots without a name show their number. **Refresh device status** rereads the names on demand. Newly added Config presets use these labels as their button text. To use a live label on an existing button, set its text to the corresponding `config_1_label` through `config_4_label` variable.

Config selection uses binary RDL V2 zone set `0x0500` with a zero-based profile byte. Current Config is read using V2 zone get `0x0501`; the corresponding responses are `0x8500` and `0x8501`. These commands were identified from the installed RDL Console and checked on firmware 0.1.27. Every change is verified by a separate current-Config query. Selecting the current Config is a no-op because the firmware may omit a redundant setter acknowledgment. The module polls the current Config at startup and with each level poll, so profile buttons also follow changes made elsewhere. Failed profile queries clear profile feedback without disabling working volume control.

Display/menu commands `DISP0`–`DISP3` do not select Config profiles. The module uses V2 Config commands and independently queries actual state. Existing development-build profile actions, option values, presets, feedback IDs, and `last_confirmed_profile` remain compatible.

## Physical volume lock

Drag **Enable Volume Lock** or **Disable Volume Lock** from the **Physical volume lock** preset group, or add **Set physical volume lock** to an existing button. The preset matching the device's reported setting is highlighted. The device controls when it asks for its existing PIN. The feedbacks and `volume_lock_enabled` report the setting, independent of whether the knob is currently showing the PIN prompt.

The module changes this setting only if the device reports support, as verified by read-only queries on `0.1.30_custom`. It reads back every change. Use **Refresh device status** to check the setting on demand.

## Variables

| Variable                                  | Meaning                                                    |
| ----------------------------------------- | ---------------------------------------------------------- |
| `connected`                               | 1 when valid level replies are being received, otherwise 0 |
| `model`, `firmware`                       | Device capabilities                                        |
| `ch1_attenuation`, `ch2_attenuation`      | Positive attenuation; 64 represents mute                   |
| `ch1_db`, `ch2_db`                        | Negative dB, or `-inf` when muted                          |
| `ch1_muted`, `ch2_muted`                  | 1 muted, 0 unmuted                                         |
| `ch1_display`, `ch2_display`              | Human-readable level or MUTE                               |
| `active_profile`                          | Current Config 1–4 from device readback; blank if unknown  |
| `last_confirmed_profile`                  | Compatibility alias for `active_profile`                   |
| `config_1_label` through `config_4_label` | Config number and the saved name, when available           |
| `volume_lock_enabled`                     | 1 enabled, 0 disabled, blank if unavailable                |

Level variables become blank (display variables become Unknown) when disconnected. Feedbacks cover mute, attenuation thresholds, connection state, and the queried active Config. The Both presets show channel A's level; use separate A/B buttons or both variables when channels have different levels.

## Optional experimental display firmware

A separate [D-NVC2 0.1.30 UI firmware prerelease](https://github.com/ukiews/companion-module-rdl-nvc2/releases/tag/0.1.30_custom) provides a larger numeric volume display, taller cyan level bar, and prominent red mute view. It is optional and is not a Companion module update or an official RDL release. See [firmware details, source, validation, and installation limitations](firmware-ui/README.md). The Companion module does not require modified firmware.

## Development

Use Node 22.20+ within the Node 22 release line and pnpm 11:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm check
pnpm package
```

The resulting `.tgz` is a Companion module package, not an npm package. Automated CI runs offline tests, validates the manifest, builds, and uploads the package. Source changes are MIT licensed. RDL's supplied proprietary protocol documents are not redistributed or relicensed in this repository. No RDL affiliation or endorsement is implied.

## Commissioning

Offline tests never contact hardware. The following opt-in command changes live output levels and restores them in a `finally` block:

```sh
node tools/live-test.js DEVICE_IP LOCAL_INTERFACE_IP
```

To also cycle Config 1–4, supply `--profiles`. The tool reads and restores the original Config automatically:

```sh
node tools/live-test.js DEVICE_IP LOCAL_INTERFACE_IP --profiles
```

Run only on an idle device. The test avoids 0 dB/full-volume settings, but does temporarily mute outputs. An abrupt process termination or network failure can prevent restore; the tool reports restore failures. See [hardware validation](HARDWARE-VALIDATION.md) for results.
