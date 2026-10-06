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
    struct State { input: Vec<u32>, output: Vec<u8>, width: usize, height: usize }
    thread_local! { static STATE: RefCell<State> = RefCell::new(State::default()); }

    #[no_mangle] pub extern "C" fn overview_abi_version() -> u32 { 1 }

    #[no_mangle] pub extern "C" fn overview_prepare(width: u32, height: u32) -> u32 {
        STATE.with(|state| {
            let mut s = state.borrow_mut();
            s.width = 0; s.height = 0; s.input.clear(); s.output.clear();
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
                s.output.clear(); return 1;
            }
            let State { input, output, width, height } = &mut *s;
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
}
