//! Bounded, world-independent ordinary terrain neighbourhood planning.
//! Input is two little-endian u32 words per column-major cell, never JS objects.
//! Word 0: u16 tile type, bit 16 active, bit 17 invisible block.
//! Word 1: u16 wall type, bit 16 invisible wall.
//! Output is [wall frame index, ordinary tile neighbour mask] per cell.

const MAX_CELLS: usize = 65_536;
const ACTIVE: u32 = 1 << 16;
const INVISIBLE_BLOCK: u32 = 1 << 17;
const INVISIBLE_WALL: u32 = 1 << 16;
const WALL_CENTER: [[u8; 3]; 3] = [[2, 0, 0], [0, 1, 4], [0, 3, 0]];
const LIQUID_PRESENT: u32 = 1 << 14;
const LIQUID_INACTIVE: u32 = 1 << 15;
const LIQUID_KNOWN: u32 = 1 << 16;
const LIQUID_SOLID: u32 = 1 << 17;
const LIQUID_VALID: u32 = 1 << 18;

// Each entry packs a column-major cell index and a five-bit classification.
// 1 retains the complete JS reference (shapes, edges, mixed/special/unknown
// neighbourhoods); 2 is a proved occluded wet solid; 16..23 are ordinary wet
// cells with north/west/east occupied bits. Dry, irrelevant cells emit nothing.
fn plan_liquid_candidates(input: &[u32], metadata: &[u32], output: &mut Vec<u32>,
                          width: usize, height: usize) -> u32 {
    output.clear();
    let mut fast = 0;
    for x in 0..width { for y in 0..height {
        let i = x * height + y;
        let own = metadata[i];
        if own & LIQUID_PRESENT == 0 { continue; }
        let fallback = ((i as u32) << 5) | 1;
        if own & LIQUID_VALID == 0 { output.push(fallback); continue; }
        let amount = own & 255;
        let kind = (own >> 8) & 7;
        let shape = (own >> 11) & 7;
        if amount == 0 {
            if shape == 0 || own & LIQUID_SOLID == 0 { continue; }
            let neighbours = [(y > 0, i.wrapping_sub(1)),
                (x > 0, i.wrapping_sub(height)), (x + 1 < width, i + height),
                (y + 1 < height, i + 1)];
            if neighbours.iter().any(|&(present, n)| present &&
                (metadata[n] & 255 != 0 || metadata[n] & LIQUID_VALID == 0)) {
                output.push(fallback);
            }
            continue;
        }
        if kind == 0 || kind > 3 || x == 0 || y == 0 || x + 1 == width || y + 1 == height {
            output.push(fallback); continue;
        }
        let mut ordinary = true;
        for nx in x - 1..=x + 1 { for ny in y - 1..=y + 1 {
            let n = nx * height + ny;
            let m = metadata[n];
            if m & (LIQUID_PRESENT | LIQUID_VALID) != (LIQUID_PRESENT | LIQUID_VALID) {
                ordinary = false; continue;
            }
            if input[n * 2] & ACTIVE != 0 && m & LIQUID_INACTIVE == 0 {
                let tile_type = input[n * 2] & 0xffff;
                if m & LIQUID_KNOWN == 0 || (m >> 11) & 7 != 0 ||
                    tile_type == 379 || tile_type == 518 || tile_type == 546 {
                    ordinary = false;
                }
            }
            if m & 255 != 0 && (m >> 8) & 7 != kind { ordinary = false; }
        }}
        if !ordinary { output.push(fallback); continue; }
        if own & LIQUID_SOLID != 0 {
            output.push(((i as u32) << 5) | 2); fast += 1; continue;
        }
        let mut occupied = 0;
        for (n, bit) in [(i - 1, 1), (i - height, 2), (i + height, 4)] {
            let m = metadata[n];
            if m & LIQUID_SOLID != 0 || (m & 255 != 0 && (m >> 8) & 7 == kind) {
                occupied |= bit;
            }
        }
        output.push(((i as u32) << 5) | 16 | occupied);
        fast += 1;
    }}
    fast
}

fn visible_wall(word: u32, reveal: bool) -> bool {
    let wall = word & 0xffff;
    wall > 0 && (reveal || (word & INVISIBLE_WALL == 0 && wall != 318))
}

fn matching_tile(word: u32, kind: u32, reveal: bool) -> bool {
    word & ACTIVE != 0 && word & 0xffff == kind
        && (reveal || word & INVISIBLE_BLOCK == 0)
}

fn plan(input: &[u32], output: &mut [u8], width: usize, height: usize,
        world_x_mod3: usize, world_y_mod3: usize, reveal: bool) {
    for x in 0..width {
        for y in 0..height {
            let i = x * height + y;
            let kind = input[i * 2] & 0xffff;
            let mut wall = 0;
            let mut tile = 0;
            // Fixed region-edge framing matches the reference planner, including
            // its deliberate refusal to consult an extra world/context accessor.
            let neighbours = [
                (y > 0, i.wrapping_sub(1), 1),
                (x > 0, i.wrapping_sub(height), 2),
                (x + 1 < width, i + height, 4),
                (y + 1 < height, i + 1, 8),
            ];
            for (present, n, bit) in neighbours {
                if !present { continue; }
                if visible_wall(input[n * 2 + 1], reveal) { wall |= bit; }
                if matching_tile(input[n * 2], kind, reveal) { tile |= bit; }
            }
            if wall == 15 {
                wall += WALL_CENTER[(x + world_x_mod3) % 3][(y + world_y_mod3) % 3];
            }
            output[i * 2] = wall;
            output[i * 2 + 1] = tile;
        }
    }
}


// Stream metadata: word 0 carries presence, canonical shape, saved-frame and
// diagnostic flags; word 1 holds identity paints. No per-owner JS commands.
const STREAM_PRESENT: u32 = 1 << 3;
const STREAM_SAVED_FRAME: u32 = 1 << 4;
const STREAM_TILE_PAINT_VALID: u32 = 1 << 10;
const STREAM_WALL_PAINT_VALID: u32 = 1 << 11;
fn ordinary_type(kind: u32) -> bool { matches!(kind, 0 | 1 | 2 | 6 | 7 | 8 | 9 | 22 | 23 | 25 | 30 | 37 | 38 | 39 | 40 | 41 | 43 | 44 | 45 | 46 | 47 | 48 | 53 | 56 | 57 | 58 | 59 | 60 | 63 | 64 | 65 | 66 | 67 | 68 | 70 | 75 | 76 | 107 | 108 | 109 | 111 | 112 | 116 | 117 | 118 | 119 | 120 | 121 | 122 | 140 | 147 | 161 | 163 | 164 | 166 | 167 | 168 | 169 | 175 | 176 | 177 | 179 | 180 | 181 | 182 | 183 | 189 | 190 | 191 | 192 | 193 | 194 | 195 | 196 | 197 | 198 | 199 | 200 | 202 | 203 | 204 | 206 | 208 | 211 | 221 | 222 | 223 | 224 | 225 | 226 | 229 | 230 | 232 | 234 | 239 | 248 | 250 | 251 | 252 | 253 | 123 | 151 | 367 | 368 | 383 | 396 | 397 | 402 | 403 | 404) }
#[derive(Default)]
struct TerrainStream {
    metadata: Vec<u32>, records: Vec<i32>, recipes: Vec<u32>,
    keys: Vec<u32>, slots: Vec<u32>, wall_fallback: Vec<u32>, tile_fallback: Vec<u32>,
    wall_assets: Vec<u32>, tile_assets: Vec<u32>, asset_bits: Vec<u8>,
    // Counts: wall logical/drawn/hidden/culled; tile logical/drawn/hidden/
    // culled/shapes; cell paint/liquid/wires/inactive/coatings; two reserved.
    counts: [u32; 16], wall_records: usize, events: Vec<i32>, tokens: Vec<i32>,
}
impl TerrainStream {
    fn clear(&mut self) {
        self.metadata.clear(); self.records.clear(); self.recipes.clear();
        self.wall_fallback.clear(); self.tile_fallback.clear(); self.wall_assets.clear();
        self.tile_assets.clear(); self.counts.fill(0); self.wall_records=0;
        self.events.clear(); self.tokens.clear();
    }
    fn bytes(&self) -> usize {
        (self.metadata.capacity()+self.records.capacity()+self.recipes.capacity()+
         self.keys.capacity()+self.slots.capacity()+self.wall_fallback.capacity()+
         self.tile_fallback.capacity()+self.wall_assets.capacity()+self.tile_assets.capacity()+
         self.events.capacity()+self.tokens.capacity())*4+self.asset_bits.capacity()+64
    }
    fn asset(&mut self, wall: bool, kind: u32) {
        let at=kind as usize*2+if wall {1} else {0};
        if self.asset_bits[at]==0 { self.asset_bits[at]=1;
            if wall { self.wall_assets.push(kind); } else { self.tile_assets.push(kind); }
        }
    }
    fn append(&mut self, recipe: u32, x: usize, y: usize, wall: bool, shape: u32) {
        let mask=self.keys.len()-1;
        let mut at=(recipe.wrapping_mul(2654435761) as usize)&mask;
        while self.keys[at]!=0 && self.keys[at]!=recipe {at=(at+1)&mask;}
        let slot=if self.keys[at]==0 {
            let slot=self.recipes.len() as u32; self.recipes.push(recipe);
            self.keys[at]=recipe; self.slots[at]=slot; slot
        } else {self.slots[at]};
        let dx=x as i32*16-if wall {8} else {0};
        let dy=y as i32*16+if wall {-8} else if shape==1 {8} else {0};
        self.records.extend_from_slice(&[slot as i32,dx,dy,x as i32,y as i32]);
    }
    fn plan(&mut self,input:&[u32],masks:&[u8],width:usize,height:usize,
            flags:u32, tile_bounds:[i32;4],wall_bounds:[i32;4]) {
        self.records.clear();self.recipes.clear();self.wall_fallback.clear();self.tile_fallback.clear();
        self.wall_assets.clear();self.tile_assets.clear();self.counts.fill(0);self.tokens.clear();
        let inside=|x:usize,y:usize,b:[i32;4]| x as i32>=b[0]&&(x as i32)<b[1]&&y as i32>=b[2]&&(y as i32)<b[3];
        let area=|b:[i32;4]| ((b[1].clamp(0,width as i32)-b[0].clamp(0,width as i32)).max(0) as usize)*
            ((b[3].clamp(0,height as i32)-b[2].clamp(0,height as i32)).max(0) as usize);
        let limit=(if flags&1!=0 {area(tile_bounds)} else {0})+(if flags&2!=0 {area(wall_bounds)} else {0});
        self.records.reserve_exact(limit*5); self.recipes.reserve_exact(limit);
        let hash_size=(limit.max(1)*2).next_power_of_two();
        self.keys.resize(hash_size,0);self.keys.fill(0);self.slots.resize(hash_size,0);
        self.asset_bits.resize(65536*2,0);self.asset_bits.fill(0);
        let reveal=flags&8!=0;let paint=flags&4!=0;
        if flags&2!=0 {for x in 0..width {for y in 0..height {
            let i=x*height+y;let wall=input[i*2+1]&65535;if wall==0 {continue;}
            if !visible_wall(input[i*2+1],reveal) {self.counts[2]+=1;continue;}
            let metadata=self.metadata[i*2];let paints=self.metadata[i*2+1];
            let valid=!paint || metadata&STREAM_WALL_PAINT_VALID!=0;
            if !valid {self.wall_fallback.push(i as u32);continue;}
            self.counts[0]+=1;self.counts[1]+=1;self.asset(true,wall);
            if !inside(x,y,wall_bounds) {self.counts[3]+=1;continue;}
            let identity=if paint && (paints>>8)&255==31 {1} else {0};
            self.append(0x01000000+wall*40+masks[i*2] as u32*2+identity,x,y,true,0);
        }}}
        self.wall_records=self.records.len()/5;
        for x in 0..width {for y in 0..height {
            let i=x*height+y;let metadata=self.metadata[i*2];
            if metadata&STREAM_PRESENT==0 {continue;}
            for bit in 5..=9 {if metadata&(1<<bit)!=0 {self.counts[bit+4]+=1;}}
            if flags&1==0 || input[i*2]&ACTIVE==0 {continue;}
            if !reveal && input[i*2]&INVISIBLE_BLOCK!=0 {self.counts[6]+=1;continue;}
            let kind=input[i*2]&65535;let shape=metadata&7;
            if !ordinary_type(kind) || shape>5 || metadata&STREAM_SAVED_FRAME!=0 ||
                (paint && metadata&STREAM_TILE_PAINT_VALID==0) {
                self.tile_fallback.push(i as u32);continue;
            }
            self.counts[4]+=1;self.counts[5]+=1;if shape!=0 {self.counts[8]+=1;}
            self.asset(false,kind);
            if !inside(x,y,tile_bounds) {self.counts[7]+=1;continue;}
            let identity=if paint && self.metadata[i*2+1]&255==31 {1} else {0};
            self.append(1+((kind*6+shape)*16+masks[i*2+1] as u32)*2+identity,x,y,false,shape);
        }}
    }
    // Only sparse JS objects are passed as [ownerIndex, objectIndex]. Ordinary
    // owner order, negative tokens and the final mixed stream are written here.
    fn merge(&mut self,kind:u32,height:usize)->bool {
        if kind>2 || self.events.len()%2!=0 {return false;}
        let (start,end)=match kind {1=>(0,self.wall_records),2=>(self.wall_records,self.records.len()/5),_=>(0,0)};
        if self.tokens.len()+end-start+self.events.len()/2>131072 {return false;}
        let mut event=0;
        for i in start..end {
            let owner=self.records[i*5+3]*height as i32+self.records[i*5+4];
            while event<self.events.len() && self.events[event]<=owner {
                self.tokens.push(self.events[event+1]);event+=2;
            }
            self.tokens.push(-(i as i32)-1);
        }
        while event<self.events.len() {self.tokens.push(self.events[event+1]);event+=2;}
        true
    }
}

// One instance belongs to one renderer. Views are invalidated by prepare/release.
// No source textures, expanded world, or world results are retained here.
#[cfg(target_arch = "wasm32")]
mod abi {
    use super::*;
    use std::cell::RefCell;
    #[derive(Default)]
    struct State { input: Vec<u32>, output: Vec<u8>, liquid_input: Vec<u32>,
        liquid_output: Vec<u32>, liquid_fast: u32, width: usize, height: usize, stream: TerrainStream }
    thread_local! { static STATE: RefCell<State> = RefCell::new(State::default()); }

    #[no_mangle] pub extern "C" fn overview_abi_version() -> u32 { 3 }

    #[no_mangle] pub extern "C" fn overview_prepare(width: u32, height: u32) -> u32 {
        STATE.with(|state| {
            let mut s = state.borrow_mut();
            s.width = 0; s.height = 0; s.input.clear(); s.output.clear();
            s.liquid_input.clear(); s.liquid_output.clear();
            s.liquid_fast = 0; s.stream.clear();
            let cells = width as u64 * height as u64;
            if width == 0 || height == 0 || width > 512 || height > 512 || cells > MAX_CELLS as u64 {
                return 0;
            }
            let count = cells as usize * 2;
            if s.input.try_reserve_exact(count).is_err() || s.output.try_reserve_exact(count).is_err() {
                return 0;
            }
            s.input.resize(count, 0); s.output.resize(count, 0);
            s.width = width as usize; s.height = height as usize;
            s.input.as_mut_ptr() as u32
        })
    }

    #[no_mangle] pub extern "C" fn overview_plan(x_mod3: u32, y_mod3: u32, reveal: u32) -> u32 {
        STATE.with(|state| {
            let mut s = state.borrow_mut();
            if s.width == 0 || s.height == 0 || x_mod3 > 2 || y_mod3 > 2 || reveal > 1 {
                s.output.clear(); s.liquid_output.clear(); s.liquid_fast = 0; return 1;
            }
            let State { input, output, width, height, .. } = &mut *s;
            output.resize(*width * *height * 2, 0);
            plan(input, output, *width, *height, x_mod3 as usize, y_mod3 as usize, reveal != 0);
            0
        })
    }

    #[no_mangle] pub extern "C" fn overview_output_ptr() -> u32 {
        STATE.with(|s| s.borrow().output.as_ptr() as u32)
    }
    #[no_mangle] pub extern "C" fn overview_output_len() -> u32 {
        STATE.with(|s| s.borrow().output.len() as u32)
    }
    #[no_mangle] pub extern "C" fn overview_prepare_liquids() -> u32 {
        STATE.with(|state| {
            let mut s = state.borrow_mut();
            let cells = s.width * s.height;
            s.liquid_input.clear(); s.liquid_output.clear();
            s.liquid_fast = 0;
            if cells == 0 || s.liquid_input.try_reserve_exact(cells).is_err() ||
                s.liquid_output.try_reserve_exact(cells).is_err() { return 0; }
            s.liquid_input.resize(cells, 0);
            s.liquid_input.as_mut_ptr() as u32
        })
    }
    #[no_mangle] pub extern "C" fn overview_plan_liquids() -> u32 {
        STATE.with(|state| {
            let mut s = state.borrow_mut();
            if s.width == 0 || s.liquid_input.len() != s.width * s.height {
                s.liquid_output.clear(); s.liquid_fast = 0; return 1;
            }
            let State { input, liquid_input, liquid_output, liquid_fast, width, height, .. } = &mut *s;
            *liquid_fast = plan_liquid_candidates(input, liquid_input, liquid_output, *width, *height);
            0
        })
    }
    #[no_mangle] pub extern "C" fn overview_liquid_output_ptr() -> u32 {
        STATE.with(|s| s.borrow().liquid_output.as_ptr() as u32)
    }
    #[no_mangle] pub extern "C" fn overview_liquid_output_len() -> u32 {
        STATE.with(|s| s.borrow().liquid_output.len() as u32)
    }
    #[no_mangle] pub extern "C" fn overview_liquid_fast_count() -> u32 {
        STATE.with(|s| s.borrow().liquid_fast)
    }

    #[no_mangle] pub extern "C" fn overview_prepare_stream() -> u32 {
        STATE.with(|state| {let mut s=state.borrow_mut();let count=s.width*s.height;
            if count==0 {return 0;} s.stream.metadata.resize(count*2,0);
            s.stream.metadata.as_mut_ptr() as u32})
    }
    #[no_mangle] pub extern "C" fn overview_plan_stream(flags:u32,
        tx0:i32,tx1:i32,ty0:i32,ty1:i32,wx0:i32,wx1:i32,wy0:i32,wy1:i32)->u32 {
        STATE.with(|state| {let mut s=state.borrow_mut();
            if s.width==0||s.stream.metadata.len()!=s.width*s.height*2||s.output.len()!=s.width*s.height*2||flags>15{return 1;}
            let State {input,output,width,height,stream,..}=&mut *s;
            stream.plan(input,output,*width,*height,flags,[tx0,tx1,ty0,ty1],[wx0,wx1,wy0,wy1]);0})
    }
    #[no_mangle] pub extern "C" fn overview_stream_events(count:u32)->u32 {
        STATE.with(|state| {let mut s=state.borrow_mut();if count>131072{return 0;}
            s.stream.events.resize(count as usize*2,0);s.stream.events.as_mut_ptr() as u32})
    }
    #[no_mangle] pub extern "C" fn overview_stream_merge(kind:u32)->u32 {
        STATE.with(|state| {let mut s=state.borrow_mut();let height=s.height;
            if height==0||!s.stream.merge(kind,height){1}else{0}})
    }
    #[no_mangle] pub extern "C" fn overview_stream_counts_ptr()->u32 {
        STATE.with(|s|s.borrow().stream.counts.as_ptr() as u32)
    }
    #[no_mangle] pub extern "C" fn overview_working_bytes()->u32 {
        STATE.with(|state|{let s=state.borrow(); ((s.input.capacity()+s.liquid_input.capacity()+s.liquid_output.capacity())*4+s.output.capacity()+s.stream.bytes()) as u32})
    }
    #[no_mangle] pub extern "C" fn overview_stream_records_ptr()->u32 {STATE.with(|s|s.borrow().stream.records.as_ptr() as u32)}
    #[no_mangle] pub extern "C" fn overview_stream_records_len()->u32 {STATE.with(|s|s.borrow().stream.records.len() as u32)}
    #[no_mangle] pub extern "C" fn overview_stream_recipes_ptr()->u32 {STATE.with(|s|s.borrow().stream.recipes.as_ptr() as u32)}
    #[no_mangle] pub extern "C" fn overview_stream_recipes_len()->u32 {STATE.with(|s|s.borrow().stream.recipes.len() as u32)}
    #[no_mangle] pub extern "C" fn overview_stream_wall_fallback_ptr()->u32 {STATE.with(|s|s.borrow().stream.wall_fallback.as_ptr() as u32)}
    #[no_mangle] pub extern "C" fn overview_stream_wall_fallback_len()->u32 {STATE.with(|s|s.borrow().stream.wall_fallback.len() as u32)}
    #[no_mangle] pub extern "C" fn overview_stream_tile_fallback_ptr()->u32 {STATE.with(|s|s.borrow().stream.tile_fallback.as_ptr() as u32)}
    #[no_mangle] pub extern "C" fn overview_stream_tile_fallback_len()->u32 {STATE.with(|s|s.borrow().stream.tile_fallback.len() as u32)}
    #[no_mangle] pub extern "C" fn overview_stream_wall_assets_ptr()->u32 {STATE.with(|s|s.borrow().stream.wall_assets.as_ptr() as u32)}
    #[no_mangle] pub extern "C" fn overview_stream_wall_assets_len()->u32 {STATE.with(|s|s.borrow().stream.wall_assets.len() as u32)}
    #[no_mangle] pub extern "C" fn overview_stream_tile_assets_ptr()->u32 {STATE.with(|s|s.borrow().stream.tile_assets.as_ptr() as u32)}
    #[no_mangle] pub extern "C" fn overview_stream_tile_assets_len()->u32 {STATE.with(|s|s.borrow().stream.tile_assets.len() as u32)}
    #[no_mangle] pub extern "C" fn overview_stream_tokens_ptr()->u32 {STATE.with(|s|s.borrow().stream.tokens.as_ptr() as u32)}
    #[no_mangle] pub extern "C" fn overview_stream_tokens_len()->u32 {STATE.with(|s|s.borrow().stream.tokens.len() as u32)}

    #[no_mangle] pub extern "C" fn overview_release() {
        STATE.with(|s| *s.borrow_mut() = State::default());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test] fn frame_stream_merges_sparse_specials_in_owner_order() {
        let input=vec![ACTIVE|1,2,ACTIVE|4,2,ACTIVE|2,2];
        let metadata=STREAM_PRESENT|STREAM_TILE_PAINT_VALID|STREAM_WALL_PAINT_VALID;
        let mut stream=TerrainStream::default();stream.metadata=vec![metadata,0,metadata,0,metadata,0];
        stream.plan(&input,&[0;6],3,1,3,[0,3,0,1],[0,3,0,1]);
        assert_eq!(stream.wall_records,3);assert_eq!(stream.records.len(),25);
        assert_eq!(stream.tile_fallback,vec![1]);assert_eq!(stream.counts[4],2);
        stream.events=vec![1,0];assert!(stream.merge(2,1));
        assert_eq!(stream.tokens,vec![-4,0,-5]);assert!(stream.bytes()>0);
        stream.clear();assert!(stream.tokens.is_empty()&&stream.records.is_empty());
    }

    #[test] fn all_masks_and_hidden_neighbours() {
        for mask in 0..16_u8 {
            let mut input = vec![0; 18];
            input[8] = 1 | ACTIVE;
            for (n, bit) in [(3, 1), (1, 2), (7, 4), (5, 8)] {
                if mask & bit != 0 { input[n * 2] = 1 | ACTIVE; input[n * 2 + 1] = 7; }
            }
            let mut output = vec![0; 18];
            plan(&input, &mut output, 3, 3, 0, 0, false);
            assert_eq!(output[9], mask);
            assert_eq!(output[8], if mask == 15 { 16 } else { mask });
            input[6] |= INVISIBLE_BLOCK; input[7] = 318;
            plan(&input, &mut output, 3, 3, 0, 0, false);
            assert_eq!(output[9], mask & !1);
            assert_eq!(output[8], mask & !1);
            plan(&input, &mut output, 3, 3, 0, 0, true);
            assert_eq!(output[9], mask);
        }
    }

    #[test] fn centre_variants_and_region_edges() {
        let mut input = vec![0; 18];
        for i in 0..9 { input[i * 2] = 0 | ACTIVE; input[i * 2 + 1] = 65535; }
        let mut output = vec![0; 18];
        for x in 0..3 { for y in 0..3 {
            plan(&input, &mut output, 3, 3, x, y, false);
            assert_eq!(output[8], 15 + WALL_CENTER[(x + 1) % 3][(y + 1) % 3]);
            assert_eq!(output[1], 12);
            assert_eq!(output[17], 3);
        }}
        input[6] = 1 | ACTIVE;
        plan(&input, &mut output, 3, 3, 0, 0, false);
        assert_eq!(output[9], 14);
    }

    #[test] fn maximum_region_stays_bounded() {
        let input = vec![1 | ACTIVE; MAX_CELLS * 2];
        let mut output = vec![0; MAX_CELLS * 2];
        plan(&input, &mut output, 256, 256, 0, 0, false);
        assert_eq!(output.len(), MAX_CELLS * 2);
        assert_eq!(output[1], 12);
        assert_eq!(output[output.len() - 1], 3);
    }

    #[test] fn ordinary_liquids_keep_edges_and_complex_neighbours_on_reference_path() {
        let input = vec![0; 50];
        let full = LIQUID_PRESENT | LIQUID_VALID | LIQUID_KNOWN | 255 | (1 << 8);
        let mut metadata = vec![full; 25];
        let mut candidates = Vec::new();
        plan_liquid_candidates(&input, &metadata, &mut candidates, 5, 5);
        assert_eq!(candidates.len(), 25);
        assert_eq!(candidates.iter().filter(|&&r| r & 31 == 23).count(), 9);
        metadata[12] |= LIQUID_SOLID;
        plan_liquid_candidates(&input, &metadata, &mut candidates, 5, 5);
        assert_eq!(candidates[12] & 31, 2);
        metadata[11] = (full & !(7 << 8)) | (2 << 8);
        plan_liquid_candidates(&input, &metadata, &mut candidates, 5, 5);
        assert_eq!(candidates[12] & 31, 1);
        metadata.fill(LIQUID_PRESENT | LIQUID_VALID | LIQUID_KNOWN);
        plan_liquid_candidates(&input, &metadata, &mut candidates, 5, 5);
        assert!(candidates.is_empty());
    }

    #[test] fn dry_shapes_and_unknown_records_are_conservative_candidates() {
        let input = vec![ACTIVE | 1; 18];
        let dry = LIQUID_PRESENT | LIQUID_VALID | LIQUID_KNOWN | LIQUID_SOLID;
        let mut metadata = vec![dry; 9];
        metadata[4] |= 2 << 11;
        let mut candidates = Vec::new();
        plan_liquid_candidates(&input, &metadata, &mut candidates, 3, 3);
        assert!(candidates.is_empty());
        metadata[3] |= 255 | (1 << 8);
        plan_liquid_candidates(&input, &metadata, &mut candidates, 3, 3);
        assert_eq!(candidates, vec![(3 << 5) | 1, (4 << 5) | 1]);
        metadata[3] = LIQUID_PRESENT;
        plan_liquid_candidates(&input, &metadata, &mut candidates, 3, 3);
        assert_eq!(candidates, vec![(3 << 5) | 1, (4 << 5) | 1]);
    }
}
