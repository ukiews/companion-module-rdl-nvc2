# RDL D-NVC2

Enter the device's IPv4 address. Commands use UDP 18700 and replies use multicast 239.254.50.0:9000. Select a local interface IPv4 if automatic multicast membership does not work. Allow inbound UDP and multicast on your control network.

Use Presets for volume up/down, mute toggle, and Config 1–4 selection. A = Output 1, B = Output 2. Positive volume adjustments are louder and higher attenuation is quieter. In **Set attenuation**, choose **Attenuation (dB)** for 0–63 dB or **Volume (%)** for an absolute 0–100%. In percent mode, 0% mutes, 1% is the quietest unmuted level, and 100% is full volume.

Mute restore remembers each channel's previous module-issued mute level. Restore consumes that saved level; an explicit Set or an observed external unmute clears it. Connection failures, restart/reconfiguration, and a detected bootloader clear all saved levels. If a channel is already muted without a saved level, explicitly set its attenuation. Volume up/down does not unmute. A Both toggle mutes both when either is unmuted, and restores both when both are muted. Changed levels are verified by device readback.

Config selection chooses an existing RDL Console knob/channel configuration, not a volume scene. Configure profiles in RDL Console. The module uses binary V2 Config set/get, verifies each selection with an independent device query, and polls the current Config. Profile buttons and `active_profile` show actual queried state; `last_confirmed_profile` remains as a compatibility alias. Existing development-build buttons retain their action IDs and options.

Find **Enable Volume Lock** and **Disable Volume Lock** in the **Physical volume lock** preset group. The preset matching the device's reported setting is highlighted. To configure an existing button, add **Set physical volume lock**. The device manages the inactivity timer and PIN prompt. The module reads the `volume_lock_enabled` setting at startup, about every 30 seconds, and when you use **Refresh device status**.

The module polls levels and the active Config once per second by default, waiting for the previous cycle to finish. Unchanged replies do not republish variables or reevaluate feedback. Socket failures retry automatically. The queue is bounded; volume adjustments expire after one second, and waiting adjustments are discarded on a timeout or Mute/Toggle. An operation already in progress finishes before the next action. Disconnected level values are blank/Unknown. Both-channel presets display channel A; use individual presets to see different A/B levels.

Disable the connection before a firmware update. A received bootloader identity pauses polling and controls. After the update, use Refresh device status to check identity and resume, or disable and re-enable the connection.

Hardware validation covers D-NVC2 firmware 0.1.27 and the custom display build based on 0.1.30. This is a custom module using Companion's Node 22 runtime/module API 2. Full network, behavior and development notes are in the repository README.
