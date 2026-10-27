# Hardware validation

Date: October 27, 2026. Device: RDL D-NVC2, firmware 0.1.27, two inputs and two outputs. Performed on the user's idle device. Volume and mute checks confirm control acknowledgments and queried numeric state; no audio measurements were performed.

## Config profile validation

Config tests use independent active-profile queries. Display/menu acknowledgments are not treated as proof of a Config change.

The installed RDL Console implementation identifies binary V2 zone set 0x0500 and zone get 0x0501 as Config selection and readback. Corrected validation passed:

- Queried the initial active Config using 0x0501 before making changes.
- Selected Configs 2, 3, 4 and 1 using 0x0500 with zero-based binary indices. A separate 0x0501 query returned each requested profile.
- RDL Console's system log recognized the queried active Config from the device.
- The user physically verified that the knob displayed Mixer after selecting Config 2 with the corrected command, rather than opening the menu.
- Selecting an already-active Config returns its queried state without issuing a redundant setter. Lost setter acknowledgments are accepted only if a subsequent query confirms the desired Config.
- The production module code was loaded under Node 22 with the real Companion API 2 context. Its Config 1-4 action callbacks, separate active-Config queries, variables, profile feedback, and volume action passed against the device.
- Final state after the package test: Config 1, queried attenuation 33 dB on both channels, preserving the levels present before the test.
- All 22 offline tests, manifest validation, and bundled package smoke test passed locally. Tests include captured binary responses, malformed/truncated frames, multiple frames, ignoring display ACKs, and rejection of setter ACKs without matching readback.

The saved Configs at commissioning were Combined (A+B), Mixer (A), GMeet (B), and UNUSED (no channels), all enabled. Profile definitions were not modified.

## Volume validation from initial commissioning

Passed on the same firmware:

- Capabilities identify D-NVC2 firmware 0.1.27, CHI2O2.
- Set both outputs, set A independently, and set B independently.
- Louder/quieter relative adjustments preserve A/B differences.
- Mute A, preserve mute during relative adjustment, and restore A.
- Mute/restore both outputs with distinct previous levels; linked toggle in both directions.
- Attenuation 63 and mute 64 report distinct numeric states on each output.
- Original commissioning levels of 31 dB on both outputs were restored at that time.

Gain, phantom, mixer, routing, and RU-NMP44 preset commands are not exposed for this device. Other hardware and firmware versions require commissioning.
