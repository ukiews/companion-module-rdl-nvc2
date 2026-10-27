.syntax unified
.thumb
.section .hook_enter,"ax",%progbits
b.w ui_volume_enter
.section .hook_update,"ax",%progbits
b.w ui_volume_update
