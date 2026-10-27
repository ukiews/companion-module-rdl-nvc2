# Hardware validation

Date: October 27, 2026. Device: RDL D-NVC2, firmware 0.1.27, two inputs and two outputs. Performed on the user's idle device. No test audio or listening measurement was used; volume and mute checks below confirm control acknowledgments and queried numeric state.

Initial readback: attenuation 31 dB on A and B. Console showed Config 1 selected, named Combined; Config 2 Mixer (A), Config 3 GMeet (B), and Config 4 UNUSED (no channels) were enabled.

Passed:

- Capabilities identify D-NVC2 firmware 0.1.27, CHI2O2.
- Set both outputs, set A independently, and set B independently.
- Louder and quieter relative adjustments preserve A/B differences.
- Mute A, leave A muted during relative adjustment, restore A.
- Mute both and restore their distinct previous levels.
- Toggle both to mute and back to the original distinct levels.
- Attenuation 63 reads as 63; mute 64 reads as 64 on each output.
- Config selection sequence 1, 2, 3, 4, 2, 3, 1: received matching device acknowledgments for each.
- Config selection in the installed RDL Console UI was exercised for Configs 2 and 3. Config 2's multicast response matched `ACKDISP1`.
- Final queried attenuation restored to 31 dB on both outputs. Final Config 1 command acknowledged.
- The production package was loaded under Node 22 with the real Companion API 2 context. Its connection, published variables, volume action, Config 1–4 action callbacks, profile feedback, and final restore passed against the live device. The 16 offline tests and manifest validation also passed.

Limits: Config tests verify command acceptance, not the physical knob's LCD or behavior under rotation. The Console UI caches its radio selection and does not reliably reflect commands sent by another controller. `QDISP` and `QU` return NAK on this firmware. No reliable current-Config query is known. The source protocol documents cover additional models; gain, phantom, mixer, routing, and RU-NMP44 preset commands are intentionally not exposed for this device.
