"""Rasterize local Arial into compact 4-bit coverage tables for RGB565 rendering.
No TTF file is copied into an output or uploaded. Generated assets remain local.
"""
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont
import json,os

ROOT=Path(__file__).resolve().parent
FONT=Path(os.environ.get('RDL_UI_FONT','C:/Windows/Fonts/arial.ttf'))
OUT=ROOT/'build'
OUT.mkdir(exist_ok=True)
specs=[('profile',22,range(32,256)),('number',78,map(ord,'0123456789?')),
       ('mute',48,map(ord,'MUTED?')),('hint',20,map(ord,'Press to unmute?'))]
header=['/* Generated local font bitmaps. See generate_fonts.py. */']
metrics={}
for name,size,points in specs:
    font=ImageFont.truetype(str(FONT),size)
    codepoints={cp for cp in points if cp<127 or cp>=160}
    if name=='profile': codepoints.update(range(0x400,0x460))
    data=bytearray();glyphs=[];bounds={}
    for cp in sorted(codepoints):
        char=chr(cp);left,top,right,bottom=font.getbbox(char,anchor='lt')
        w,h=max(0,right-left),max(0,bottom-top)
        # Per-font top positions center capital ink in the CSS line boxes.
        cap=font.getbbox('H',anchor='ls');cap_height=cap[3]-cap[1]
        baseline=(size-cap_height)//2+cap_height
        ls=font.getbbox(char,anchor='ls')
        glyph_top=baseline+ls[1]
        im=Image.new('L',(max(1,w),max(1,h)),0)
        ImageDraw.Draw(im).text((-left,-top),char,font=font,fill=255,anchor='lt')
        values=[(v*15+127)//255 for v in im.tobytes()] if w*h else []
        offset=len(data)
        for i in range(0,len(values),2): data.append(values[i]<<4|(values[i+1] if i+1<len(values) else 0))
        advance=round(font.getlength(char))
        # Keep every bitmap column inside its advance cell. In particular, a
        # tightened number cell clipped a few antialiased edge pixels of '5'.
        advance=max(advance,left+w)
        glyphs.append((cp,offset,w,h,advance,left,glyph_top))
        bounds[char]={'top':glyph_top,'bottom':glyph_top+h,'advance':advance}
    assert len(data)<65536
    header.append(f'static const uint8_t pixels_{name}[]={{'+','.join(map(str,data))+'};')
    header.append(f'static const Glyph glyphs_{name}[]={{'+','.join('{'+','.join(map(str,g))+'}' for g in glyphs)+'};')
    header.append(f'static const Font font_{name}={{glyphs_{name},pixels_{name},{len(glyphs)},{size}}};')
    metrics[name]={'size':size,'bitmapBytes':len(data),'glyphCount':len(glyphs),'bounds':bounds}
(OUT/'fonts.h').write_text('\n'.join(header)+'\n')
(OUT/'font-metrics.json').write_text(json.dumps(metrics,indent=2,ensure_ascii=False),encoding='utf-8')
print({k:{i:v[i] for i in ['bitmapBytes','glyphCount']} for k,v in metrics.items()})
