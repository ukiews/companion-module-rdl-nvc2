# RDL D-NVC2

Enter the device's IPv4 address. Commands use UDP 18700 and replies use multicast 239.254.50.0:9000. Select a local interface IPv4 if automatic multicast membership does not work. Allow inbound UDP and multicast on your control network.

Use Presets for volume up/down, mute toggle, and Config 1–4 selection. A = Output 1, B = Output 2. Positive volume adjustments are louder; higher attenuation is quieter. Set attenuation supports 0–63 dB. Mute is 64.

Mute restore remembers each channel's previous level only while the connection is running. After a restart, explicitly set a level if a channel is already muted. Volume up/down does not unmute. A Both toggle mutes both when either is unmuted, and restores both when both are muted.

Config selection chooses an existing RDL Console knob/channel configuration, not a volume scene. Configure profiles in RDL Console. Profile buttons and `last_confirmed_profile` track the latest received selection acknowledgment, starting unknown after startup/reconnection. The current profile cannot be queried with the supplied protocol. Volume control and polling work independently of the selected knob profile.

The module polls actual output levels for physical knob changes. Disconnected level values are blank/Unknown. Both-channel presets display channel A; use individual presets to see different A/B levels.

Tested on D-NVC2 firmware 0.1.27. This is a custom module using Companion's Node 22 runtime/module API 2. Full network, behavior and development notes are in the repository README.
