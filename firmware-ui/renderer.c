/* Local UI experiment for the exact D-NVC2 0.1.30 image. No audio/network changes. */
#include <stdint.h>
#include <stddef.h>

typedef struct {
    uint32_t codepoint;
    uint16_t offset;
    uint8_t width, height, advance;
    int8_t left, top;
} Glyph;
typedef struct {
    const Glyph *glyphs;
    const uint8_t *pixels;
    uint16_t count;
    uint8_t height;
} Font;
#include "fonts.h"

#define STATE ((volatile uint8_t *)0x24004f5cu)
#define FLAGS (*(volatile uint32_t *)STATE)
#define NORMAL_DRAWN 2u /* Same display-only bit used by the stock speaker renderer. */
#define LCD_WINDOW ((void (*)(uint16_t,uint16_t,uint16_t,uint16_t))0x08065335u)
#define LCD_DATA ((void (*)(void))0x0806524du)
#define SPI_TX ((uint32_t (*)(void *,const uint8_t *,uint16_t,uint32_t))0x0806e799u)
#define EFFECTIVE_LEVEL ((uint8_t (*)(uint8_t))0x08061e01u)

/* Deliberately small: the stock display thread has a 1024-byte stack. */
typedef struct { uint8_t bytes[96]; uint16_t used; uint8_t failed; } Stream;
static void flush(Stream *s) {
    if (s->used && !s->failed) {
        if(SPI_TX((void *)0x240057a0u,s->bytes,s->used,200)!=0) s->failed=1;
        s->used=0;
    }
}
static void pixel(Stream *s,uint16_t c) {
    if(s->failed) return;
    s->bytes[s->used++]=(uint8_t)(c>>8);
    s->bytes[s->used++]=(uint8_t)c;
    if (s->used==sizeof(s->bytes)) flush(s);
}
static int window(int x,int y,int w,int h) {
    if(x<0 || y<0 || w<=0 || h<=0 || x+w>240 || y+h>240) return 0;
    LCD_WINDOW(x,y,x+w-1,y+h-1); LCD_DATA(); return 1;
}
static uint16_t rgb(unsigned r,unsigned g,unsigned b) {
    return (uint16_t)(((r>>3)<<11)|((g>>2)<<5)|(b>>3));
}
static uint16_t blend(uint16_t fg,uint16_t bg,unsigned a) {
    if(a==0) return bg;
    if(a==15) return fg;
    unsigned z=15-a;
    unsigned r=(((fg>>11)&31)*a+((bg>>11)&31)*z+7)/15;
    unsigned g=(((fg>>5)&63)*a+((bg>>5)&63)*z+7)/15;
    unsigned b=((fg&31)*a+(bg&31)*z+7)/15;
    return (uint16_t)((r<<11)|(g<<5)|b);
}
static int fill(int x,int y,int w,int h,uint16_t c) {
    if(!window(x,y,w,h)) return 0;
    Stream s; s.used=0; s.failed=0;
    for(int n=0;n<w*h;n++) pixel(&s,c);
    flush(&s); return !s.failed;
}
static const Glyph *glyph(const Font *f,uint32_t cp) {
    int low=0,high=f->count;
    while(low<high) {
        int mid=(low+high)/2;
        if(f->glyphs[mid].codepoint<cp) low=mid+1; else high=mid;
    }
    if(low<f->count && f->glyphs[low].codepoint==cp) return &f->glyphs[low];
    if(cp!='?') return glyph(f,'?');
    return NULL;
}
/* Profile buffers in the vendor image have 32-byte slots. Never read past one. */
static uint32_t next_char(const char **cursor,const char *end) {
    if(*cursor>=end || !**cursor) return 0;
    uint8_t a=(uint8_t)*(*cursor)++;
    if(a<0x80) return a;
    if(a>=0xc2 && a<=0xdf && *cursor<end) {
        uint8_t b=(uint8_t)**cursor;
        if((b&0xc0)==0x80) {(*cursor)++;return ((a&31)<<6)|(b&63);}
    }
    /* Latin-1 and Cyrillic are included; malformed/unavailable glyphs use ?. */
    if(a>=0xe0 && a<=0xef && end-*cursor>=2) {
        uint8_t b=(uint8_t)(*cursor)[0],c=(uint8_t)(*cursor)[1];
        if((b&0xc0)==0x80 && (c&0xc0)==0x80) {
            (*cursor)+=2; uint32_t cp=((a&15)<<12)|((b&63)<<6)|(c&63);
            if(cp>=0x800 && !(cp>=0xd800 && cp<=0xdfff)) return cp;
        }
    }
    return '?';
}
static int measure(const Font *f,const char *text,int len) {
    const char *p=text,*end=text+len; int width=0; uint32_t cp;
    while((cp=next_char(&p,end))) {const Glyph *g=glyph(f,cp); if(g) width+=g->advance;}
    return width;
}
static unsigned alpha(const Font *f,const Glyph *g,int x,int y) {
    if(!g || x<0 || y<0 || x>=g->width || y>=g->height) return 0;
    unsigned index=(unsigned)y*g->width+x;
    uint8_t a=f->pixels[g->offset+(index>>1)];
    return (index&1)?(a&15):(a>>4);
}
/* Compose whole text rows, including their background: no clear-then-draw flicker. */
static int text_box(const Font *f,const char *text,int len,int x,int y,int w,int h,
                     uint16_t fg,uint16_t bg) {
    if(!window(x,y,w,h)) return 0;
    int width=measure(f,text,len),ellipsis=width>w;
    int dots=measure(f,"...",3),visible=0; const char *end=text+len,*p=text;
    if(ellipsis) {
        while(p<end && *p) {
            const char *before=p; uint32_t cp=next_char(&p,end);const Glyph *g=glyph(f,cp);
            int adv=g?g->advance:0;
            if(visible+adv+dots>w) {end=before;break;}
            visible+=adv;
        }
        width=visible+dots;
    }
    int left=(w-width)/2;
    Stream s; s.used=0; s.failed=0;
    for(int row=0;row<h;row++) {
        int pos=0; p=text;
        while(pos<left) {pixel(&s,bg);pos++;}
        for(int part=0;part<(ellipsis?2:1);part++) {
            const char *part_end=part?"..."+3:end;
            if(part) p="...";
            uint32_t cp;
            while((cp=next_char(&p,part_end))) {
                const Glyph *g=glyph(f,cp);
                if(!g) continue;
                int ink_y=row-(h-f->height)/2-g->top;
                for(int col=0;col<g->advance && pos<w;col++,pos++)
                    pixel(&s,blend(fg,bg,alpha(f,g,col-g->left,ink_y)));
            }
        }
        while(pos<w) {pixel(&s,bg);pos++;}
    }
    flush(&s); return !s.failed;
}
static int cap_inset(int row) {
    /* Taller 22-pixel bar, with circular end caps. */
    static const uint8_t inset[22]={8,5,4,3,2,1,1,1,0,0,0,0,0,0,1,1,1,2,3,4,5,8};
    return inset[row];
}
static int level_bar(unsigned level,uint16_t bg) {
    const int w=196,h=22;
    unsigned filled=((level-1)*w+49)/99;
    uint16_t track=rgb(44,57,66),accent=rgb(78,216,232);
    if(!window(22,181,w,h)) return 0;
    Stream s; s.used=0; s.failed=0;
    for(int y=0;y<h;y++) {
        int inset=cap_inset(y);
        for(int x=0;x<w;x++) {
            uint16_t c=(x<inset || x>=w-inset)?bg:track;
            if(filled && x>=inset && x<(int)filled-inset) c=accent;
            pixel(&s,c);
        }
    }
    flush(&s); return !s.failed;
}
static void render(int force) {
    unsigned profile=STATE[0x25]; if(profile>3) profile=0;
    unsigned attenuation=EFFECTIVE_LEVEL((uint8_t)profile);
    int muted=attenuation>=64;
    int was_normal=(FLAGS&NORMAL_DRAWN)!=0;
    uint16_t bg=muted?rgb(146,28,43):rgb(16,23,28),fg=rgb(248,250,252);
    if(force) {
        /* Keep the opposite marker until a forced redraw completes. A failed
           transfer will therefore be retried in full on the next update. */
        if(muted) FLAGS|=NORMAL_DRAWN; else FLAGS&=~NORMAL_DRAWN;
    }
    if((force || was_normal==muted) && !fill(0,0,240,240,bg)) return;
    const char *name=((const char * volatile *)(STATE+0x28))[profile];
    if((uintptr_t)name<0x24000000u || (uintptr_t)name>0x2407ffe0u) name="";
    if(!text_box(&font_profile,name,32,12,17,216,26,fg,bg)) return;
    if(muted) {
        if(force || was_normal) {
            if(!text_box(&font_mute,"MUTED",5,12,90,216,58,rgb(255,255,255),bg)) return;
            /* MUTED ink occupies y=102..136; center hint ink at (137+240)/2. */
            if(!text_box(&font_hint,"Press to unmute",15,12,173,216,28,rgb(255,255,255),bg)) return;
        }
        FLAGS&=~NORMAL_DRAWN;
    } else {
        unsigned level=1+((63-attenuation)*99+31)/63;
        char number[4]; int len;
        if(level==100) {number[0]='1';number[1]='0';number[2]='0';len=3;}
        else if(level>=10) {number[0]='0'+level/10;number[1]='0'+level%10;len=2;}
        else {number[0]='0'+level;len=1;}
        if(!text_box(&font_number,number,len,12,77,216,78,fg,bg)) return;
        if(!level_bar(level,bg)) return;
        FLAGS|=NORMAL_DRAWN;
    }
}
__attribute__((used)) void ui_volume_enter(void) {render(1);}
__attribute__((used)) void ui_volume_update(void) {render(0);}
