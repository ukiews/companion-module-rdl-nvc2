# RDL D-NVC2 for Bitfocus Companion

Control an RDL D-NVC2 over its control network: independent or linked output attenuation, volume up/down, mute/restore, saved Config selection, live variables, and button feedback. D-NVC2 firmware 0.1.27 was tested on hardware. DB-NVC2 and DS-NVC2 are listed as enclosure variants; they were not separately tested.

## Install

Requires Companion 5 or newer with the Node 22 module runtime and module API 2 support. Download `rdl-nvc2-0.1.0.tgz` from this repository's release, open Companion's **Modules** page, and use **Import module package**. Add the **RDL D-NVC2** connection, enter your device's IPv4 address, and drag buttons from **Presets** to your page. This is a custom module; it is not yet in the Bitfocus module catalog.

On a computer with several network interfaces, select the IPv4 address of the local interface connected to the device. Leaving the interface blank joins multicast on every available IPv4 interface. The device address and local interface address are different settings.

## Network

Commands go to the device on UDP 18700. Replies arrive at multicast `239.254.50.0:9000` by default. Allow inbound UDP replies through the host firewall and ensure multicast is supported between the device and Companion. Different response address/port settings can be entered in the connection if already configured on the device; the module never reconfigures the device network.

Only replies whose source IPv4 matches the configured device are processed. Shared UDP binding supports other RDL applications listening on the same port. Prefer one Companion connection per device, because concurrent controllers can still interleave changes. Polling repeats after errors; each request retries once on timeout. UDP acknowledgments have no transaction IDs, so simultaneous external control cannot be made atomic.

## Volume and mute

- Channel A is Output 1; B is Output 2. Commands can target either or both.
- Set attenuation accepts 0–63 dB. Zero is full volume; larger values are quieter.
- Adjust volume uses positive values for louder and negative values for quieter. Adjustments clamp at 0/63 and leave muted channels muted.
- Mute uses 64. Hardware reports 63 and 64 distinctly, unlike the older RN-family documentation's generalized mute range.
- Restore returns each channel to its level before a module-issued mute. Restore memory is per connection and is lost on restart/reconfiguration. If a muted channel has no saved level, explicitly use Set attenuation; the module refuses to guess a restore level.
- Linked toggle mutes both if either is unmuted; it restores both if both are muted. Individual channel levels are preserved.
- The module queries current levels before volume changes and reads them again after writes. Levels from physical knob changes appear on subsequent polls. Linked writes occur sequentially, so a failure can leave one channel changed; the module logs the error and subsequent polls show actual device state.

## Saved RDL Config profiles

The **Select saved RDL Config profile** action and four presets select Config 1–4 already stored in RDL Console. These are the knob's saved channel configurations; this action does not create or modify profiles or store/recall a pair of volume values. Configure names, channel assignments, and enable flags in RDL Console.

The observed Console command is `DISP0` through `DISP3` (zero-based ASCII), with `ACKDISP0` through `ACKDISP3` replies. This extension is absent from the supplied RN protocol document; all four selection acknowledgments were checked on D-NVC2 firmware 0.1.27. Other firmware versions require commissioning. No current-profile query is known (`QDISP` returned NAK), so **last_confirmed_profile** and profile feedback indicate the latest selection acknowledgment received by this connection. They start unknown, clear on connection loss, and cannot guarantee tracking of every physical knob/menu change. RDL Console's radio selection can remain cached after external commands.

## Variables

| Variable                             | Meaning                                                    |
| ------------------------------------ | ---------------------------------------------------------- |
| `connected`                          | 1 when valid level replies are being received, otherwise 0 |
| `model`, `firmware`                  | Device capabilities                                        |
| `ch1_attenuation`, `ch2_attenuation` | Positive attenuation; 64 represents mute                   |
| `ch1_db`, `ch2_db`                   | Negative dB, or `-inf` when muted                          |
| `ch1_muted`, `ch2_muted`             | 1 muted, 0 unmuted                                         |
| `ch1_display`, `ch2_display`         | Human-readable level or MUTE                               |
| `last_confirmed_profile`             | Config 1–4; blank until an acknowledgment is observed      |

Level variables become blank (display variables become Unknown) when disconnected. Feedbacks cover mute, attenuation thresholds, connection state, and last confirmed Config selection. The Both presets show channel A's level; use separate A/B buttons or both variables when channels have different levels.

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

To also cycle Config 1–4, supply the known original Config number as the final argument. That profile is restored afterward:

```sh
node tools/live-test.js DEVICE_IP LOCAL_INTERFACE_IP 1
```

Run only on an idle device. The test avoids 0 dB/full-volume settings, but does temporarily mute outputs. An abrupt process termination or network failure can prevent restore; the tool reports restore failures. See [hardware validation](HARDWARE-VALIDATION.md) for results.
