# Changelog

## 1.0.3

- Added drag-and-drop **Enable Volume Lock** and **Disable Volume Lock** presets with button colors based on device readback.

## 1.0.2

- Enable or disable the knob's automatic physical volume lock on supported firmware.
- Confirm changes by reading the device setting and expose the result as button feedback and a variable.

## 1.0.1

- Hardened reconnects, volume action queuing, and mute restore.

## 1.0.0 — Initial release

- Independent and linked A/B output attenuation and volume adjustments.
- Mute, restore, and toggle with per-channel restore memory.
- Saved Config 1–4 selection using RDL V2, verified by independent device readback.
- Polled level and active-Config variables, connection status, and button feedback.
- Thirteen ready-to-use button presets.
- Live validation on D-NVC2 firmware 0.1.27, including physical confirmation of Config selection.
- Automated protocol, control, and Companion API tests, package validation, and GitHub CI.

Requires Companion 5 with the Node 22 module runtime. Development-build buttons remain compatible.
