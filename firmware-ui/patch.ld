ENTRY(ui_volume_enter)
SECTIONS {
 .hook_enter 0x08066160 : { KEEP(*(.hook_enter)) }
 .hook_update 0x080661e0 : { KEEP(*(.hook_update)) }
 .patch 0x080a0000 : { *(.text*) *(.rodata*) }
 .forbidden : { *(.data*) *(.bss*) *(COMMON) }
 /DISCARD/ : { *(.comment*) *(.ARM.exidx*) *(.ARM.extab*) *(.eh_frame*) }
 ASSERT(SIZEOF(.hook_enter)==4,"Entry hook must be one Thumb branch")
 ASSERT(SIZEOF(.hook_update)==4,"Update hook must be one Thumb branch")
 ASSERT(SIZEOF(.patch)<=0x20000,"Patch exceeds unused application tail")
 ASSERT(SIZEOF(.forbidden)==0,"Patch must not allocate global RAM")
}
