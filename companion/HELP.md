# RDL D-NVC2

Enter the device's IPv4 address. Commands use UDP 18700 and replies use multicast 239.254.50.0:9000. Select a local interface IPv4 if automatic multicast membership does not work. Allow inbound UDP and multicast on your control network.

Use Presets for volume up/down, mute toggle, and Config 1–4 selection. A = Output 1, B = Output 2. Positive volume adjustments are louder; higher attenuation is quieter. Set attenuation supports 0–63 dB. Mute is 64.

Mute restore remembers each channel's previous module-issued mute level. Restore consumes that saved level; an explicit Set or an observed external unmute clears it. Connection failures, restart/reconfiguration, and a detected bootloader clear all saved levels. If a channel is already muted without a saved level, explicitly set its attenuation. Volume up/down does not unmute. A Both toggle mutes both when either is unmuted, and restores both when both are muted. Changed levels are verified by device readback.

Config selection chooses an existing RDL Console knob/channel configuration, not a volume scene. Configure profiles in RDL Console. The module uses binary V2 Config set/get, verifies each selection with an independent device query, and polls the current Config. Profile buttons and `active_profile` show actual queried state; `last_confirmed_profile` remains as a compatibility alias. Existing development-build buttons retain their action IDs and options.

The module polls levels and the active Config once per second by default, waiting for the previous cycle to finish. Unchanged replies do not republish variables or reevaluate feedback. Socket failures retry automatically. The queue is bounded; volume adjustments expire after one second, and waiting adjustments are discarded on a timeout or Mute/Toggle. An operation already in progress finishes before the next action. Disconnected level values are blank/Unknown. Both-channel presets display channel A; use individual presets to see different A/B levels.

Disable the connection before a firmware update. A received bootloader identity pauses polling and controls. After the update, use Refresh device status to check identity and resume, or disable and re-enable the connection.

Hardware validation covers D-NVC2 firmware 0.1.27 and the custom display build based on 0.1.30. This is a custom module using Companion's Node 22 runtime/module API 2. Full network, behavior and development notes are in the repository README.
