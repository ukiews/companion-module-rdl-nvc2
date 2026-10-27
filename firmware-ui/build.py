"""Build a local experimental UI patch. This tool never contacts the device."""
from pathlib import Path
import hashlib,json,struct,subprocess,sys,re,os

ROOT=Path(__file__).resolve().parent
WORK=ROOT.parent
BUILD=ROOT/'build';BUILD.mkdir(exist_ok=True)
OUT=ROOT/'dist';OUT.mkdir(exist_ok=True)
BASE=0x08060000;SIZE=0x60000;PATCH=0x080a0000
EXPECTED='2fa234e1e2257d91fff0c6e293728243f37368e0c624d39b62ec2d799ee131cb'
if len(sys.argv)!=2: raise SystemExit('Usage: python build.py PATH_TO_RDL_VENDOR_HEX')
SOURCE=Path(sys.argv[1])
TOOL=Path(os.environ['ARM_GNU_BIN']) if os.environ.get('ARM_GNU_BIN') else None
def call(name,*args):
    p=subprocess.run([str(TOOL/(name+('.exe' if os.name=='nt' else ''))) if TOOL else name,*map(str,args)],text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
    if p.returncode: print(p.stdout);raise RuntimeError(f'{name} failed: {p.returncode}')
    return p.stdout
def read_hex(raw):
    image=bytearray(b'\xff'*SIZE);used=set();base=0;eof=False;entry=None
    for line in raw.decode('ascii').strip().splitlines():
        assert line.startswith(':');r=bytes.fromhex(line[1:]);assert len(r)==r[0]+5 and sum(r)%256==0
        assert not eof
        t=r[3];data=r[4:-1];address=int.from_bytes(r[1:3],'big')
        if t==4: assert len(data)==2;base=int.from_bytes(data,'big')<<16
        elif t==0:
            a=base+address;assert BASE<=a and a+len(data)<=BASE+SIZE
            for i,v in enumerate(data):
                assert a+i not in used;used.add(a+i);image[a+i-BASE]=v
        elif t==1:assert len(data)==0;eof=True
        elif t==5:assert len(data)==4;entry=data
        else:raise ValueError(f'Unsupported HEX type {t}')
    assert eof
    return image,used,entry
def record(t,a,data):
    r=bytes([len(data),a>>8,a&255,t])+bytes(data)
    return ':'+(r+bytes([-sum(r)&255])).hex().upper()
def write_hex(image,used,entry):
    lines=[];high=None;addresses=sorted(used);i=0
    while i<len(addresses):
        a=addresses[i];hi=a>>16
        if hi!=high:lines.append(record(4,0,hi.to_bytes(2,'big')));high=hi
        data=bytearray()
        while i<len(addresses) and addresses[i]==a+len(data) and addresses[i]>>16==high and len(data)<16:
            data.append(image[addresses[i]-BASE]);i+=1
        lines.append(record(0,a&65535,data))
    if entry is not None:lines.append(record(5,0,entry))
    lines.append(record(1,0,b''));return ('\r\n'.join(lines)+'\r\n').encode('ascii')
def fnv(b):
    h=0xcbf29ce484222325
    for x in b:h=((h^x)*0x100000001b3)&0xffffffffffffffff
    return f'{h:016x}'
def main():
    raw=SOURCE.read_bytes();assert hashlib.sha256(raw).hexdigest()==EXPECTED,'Exact stock image required'
    original,used,entry=read_hex(raw)
    assert original[0x6160:0x6164].hex()=='30b585b0'
    assert original[0x61e0:0x61e4].hex()=='70b584b0'
    assert original[PATCH-BASE:]==b'\xff'*(BASE+SIZE-PATCH)
    subprocess.run([sys.executable,str(ROOT/'generate_fonts.py')],check=True)
    elf=BUILD/'ui-patch.elf'
    opts=['-mcpu=cortex-m7','-mthumb','-mfloat-abi=soft','-Os','-std=c11',
          '-ffreestanding','-fno-builtin','-fno-common','-fno-unwind-tables','-fno-asynchronous-unwind-tables',
          '-fstack-usage','-ffunction-sections','-fdata-sections','-Wall','-Wextra','-Werror',
          '-nostdlib','-nostartfiles','-I'+str(BUILD),'-Wl,--gc-sections',
          '-Wl,-Map='+str(BUILD/'ui-patch.map'),'-T'+str(ROOT/'patch.ld')]
    print(call('arm-none-eabi-gcc',*opts,ROOT/'renderer.c',ROOT/'hooks.S','-o',elf))
    sections=[('.hook_enter',0x08066160),('.hook_update',0x080661e0),('.patch',PATCH)]
    modified=bytearray(original);patches=[]
    for name,address in sections:
        dest=BUILD/(name[1:]+'.bin')
        print(call('arm-none-eabi-objcopy','-O','binary','--only-section='+name,elf,dest))
        b=dest.read_bytes();assert b
        modified[address-BASE:address-BASE+len(b)]=b
        used.update(range(address,address+len(b)))
        patches.append({'section':name,'address':hex(address),'length':len(b),'sha256':hashlib.sha256(b).hexdigest()})
    allowed=lambda a:(0x08066160<=a<0x08066164 or 0x080661e0<=a<0x080661e4 or PATCH<=a<BASE+SIZE)
    changed=[BASE+i for i,(a,b) in enumerate(zip(original,modified)) if a!=b]
    assert all(map(allowed,changed))
    assert modified[:0x298]==original[:0x298],'Vector table must be untouched'
    # Supply FF through all address gaps and finish on a 32-byte H7 flashword
    # boundary. The legacy bootloader need not retain partial words across a
    # jump to the new patch sector. The resulting partition image is identical.
    used.update(range(BASE,(max(used)+32)&~31))
    encoded=write_hex(modified,used,entry)
    check,check_used,check_entry=read_hex(encoded)
    assert check==modified and check_used==used and check_entry==entry
    path=OUT/'D-NVC2-1.30-ui-experimental.hex'
    path.write_bytes(encoded);(OUT/'patched-image.bin').write_bytes(modified)
    dis=call('arm-none-eabi-objdump','-d',elf);(OUT/'patch-disassembly.txt').write_text(dis)
    symbols=call('arm-none-eabi-nm','-n','-S',elf);(BUILD/'symbols.txt').write_text(symbols)
    manifest={'status':'experimental-offline-build-not-hardware-validated','stockSha256':EXPECTED,
              'patchedHexSha256':hashlib.sha256(encoded).hexdigest(),'fullPartitionFnv1a64':fnv(modified),
              'stockPartitionFnv1a64':fnv(original),'partitionBase':hex(BASE),'partitionBytes':SIZE,
              'sections':patches,'changedBytes':len(changed),'vectorsUnchanged':True,
              'globalRamAllocated':False,'deviceWritten':False,'elf':str(elf),'hex':str(path)}
    (OUT/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    print(json.dumps(manifest,indent=2))
if __name__=='__main__':main()
