# RDL D-NVC2 for Bitfocus Companion

Control an RDL D-NVC2 over its control network: independent or linked output attenuation, volume up/down, mute/restore, saved Config selection, live variables, and button feedback. Hardware validation covers D-NVC2 firmware 0.1.27 and the custom display build based on 0.1.30. DB-NVC2 and DS-NVC2 are listed as enclosure variants; they were not separately tested.

## Install

Requires Companion 5 or newer with the Node 22 module runtime and module API 2 support. Download `rdl-nvc2-1.0.1.tgz` from the [latest module release](https://github.com/ukiews/companion-module-rdl-nvc2/releases/tag/v1.0.1), open Companion's **Modules** page, and use **Import module package**. Add the **RDL D-NVC2** connection, enter your device's IPv4 address, and drag buttons from **Presets** to your page. For an existing connection, select module version 1.0.1 after importing. This is a custom module; it is not yet in the Bitfocus module catalog.

On a computer with several network interfaces, select the IPv4 address of the local interface connected to the device. Leaving the interface blank joins multicast on every available IPv4 interface. The device address and local interface address are different settings.

## Network

Commands go to the device on UDP 18700. Replies arrive at multicast `239.254.50.0:9000` by default. Allow inbound UDP replies through the host firewall and ensure multicast is supported between the device and Companion. Different response address/port settings can be entered in the connection if already configured on the device; the module never reconfigures the device network.

Only replies whose source IPv4 matches the configured device are processed. Shared UDP binding supports other RDL applications listening on the same port. Prefer one Companion connection per device, because concurrent controllers can still interleave changes. Each request retries once on timeout. Socket failures reopen automatically with a retry delay capped at 10 seconds; three consecutive failed level polls also reopen the socket. UDP acknowledgments have no transaction IDs, so simultaneous external control cannot be made atomic.

The default polling interval is one second after the previous poll completes, configurable from 500 to 10,000 ms. A healthy cycle queries levels and the active Config; capabilities are queried at startup and after a connection failure. Unchanged replies do not republish variables or reevaluate button feedback. There are no additional background scan timers or runtime dependencies.

The action queue holds at most 32 waiting operations. Volume adjustments expire after one second and waiting adjustments are discarded on a request timeout or a subsequent Mute/Toggle action. Actions take priority over waiting polls, while explicit state changes retain their order. An operation already in progress must finish or time out before the next one can run.

Disable the connection before updating device firmware. If the module receives a bootloader identity, it pauses polling and controls automatically. After the update, use **Refresh device status** to check the device identity and resume, or disable and re-enable the connection. Automatic detection is not a substitute for disabling the connection before an update.

## Volume and mute

- Channel A is Output 1; B is Output 2. Commands can target either or both.
- Set attenuation accepts 0–63 dB. Zero is full volume; larger values are quieter.
- Adjust volume uses positive values for louder and negative values for quieter. Adjustments clamp at 0/63 and leave muted channels muted.
- Mute uses 64. Hardware reports 63 and 64 distinctly, unlike the older RN-family documentation's generalized mute range.
- Restore returns each channel to its level before a module-issued mute. Each saved level is consumed by restore and cleared by an explicit Set or an observed external unmute. All saved levels are cleared on connection failure, restart/reconfiguration, or a detected bootloader. If a muted channel has no saved level, explicitly use Set attenuation; the module refuses to guess a restore level.
- Linked toggle mutes both if either is unmuted; it restores both if both are muted. Individual channel levels are preserved.
- The module queries current levels before volume changes and verifies changed channels with readback after writes. A lost setter acknowledgment is accepted only if readback confirms the requested level. Levels from physical knob changes appear on subsequent polls. Linked writes occur sequentially, so a failure can leave one channel changed; the module logs the error and subsequent polls show actual device state.

## Saved RDL Config profiles

The **Select saved RDL Config profile** action and four presets select Config 1–4 already stored in RDL Console. These are the knob's saved channel configurations; this action does not create or modify profiles or store/recall a pair of volume values. Configure names, channel assignments, and enable flags in RDL Console.

Config selection uses binary RDL V2 zone set `0x0500` with a zero-based profile byte. Current Config is read using V2 zone get `0x0501`; the corresponding responses are `0x8500` and `0x8501`. These commands were identified from the installed RDL Console and checked on firmware 0.1.27. Every change is verified by a separate current-Config query. Selecting the current Config is a no-op because the firmware may omit a redundant setter acknowledgment. The module polls the current Config at startup and with each level poll, so profile buttons also follow changes made elsewhere. Failed profile queries clear profile feedback without disabling working volume control.

Display/menu commands `DISP0`–`DISP3` do not select Config profiles. The module uses V2 Config commands and independently queries actual state. Existing development-build profile actions, option values, presets, feedback IDs, and `last_confirmed_profile` remain compatible.

## Variables

| Variable                             | Meaning                                                    |
| ------------------------------------ | ---------------------------------------------------------- |
| `connected`                          | 1 when valid level replies are being received, otherwise 0 |
| `model`, `firmware`                  | Device capabilities                                        |
| `ch1_attenuation`, `ch2_attenuation` | Positive attenuation; 64 represents mute                   |
| `ch1_db`, `ch2_db`                   | Negative dB, or `-inf` when muted                          |
| `ch1_muted`, `ch2_muted`             | 1 muted, 0 unmuted                                         |
| `ch1_display`, `ch2_display`         | Human-readable level or MUTE                               |
| `active_profile`                     | Current Config 1–4 from device readback; blank if unknown  |
| `last_confirmed_profile`             | Compatibility alias for `active_profile`                   |

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
