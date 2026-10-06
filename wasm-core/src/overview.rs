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

// One instance belongs to one renderer. Views are invalidated by prepare/release.
// No source textures, expanded world, or world results are retained here.
#[cfg(target_arch = "wasm32")]
mod abi {
    use super::*;
    use std::cell::RefCell;
    #[derive(Default)]
    struct State { input: Vec<u32>, output: Vec<u8>, liquid_input: Vec<u32>,
        liquid_output: Vec<u32>, liquid_fast: u32, width: usize, height: usize }
    thread_local! { static STATE: RefCell<State> = RefCell::new(State::default()); }

    #[no_mangle] pub extern "C" fn overview_abi_version() -> u32 { 2 }

    #[no_mangle] pub extern "C" fn overview_prepare(width: u32, height: u32) -> u32 {
        STATE.with(|state| {
            let mut s = state.borrow_mut();
            s.width = 0; s.height = 0; s.input.clear(); s.output.clear();
            s.liquid_input.clear(); s.liquid_output.clear();
            s.liquid_fast = 0;
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
    #[no_mangle] pub extern "C" fn overview_release() {
        STATE.with(|s| *s.borrow_mut() = State::default());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
