//! Original implementation of exploreTV's bounded modern WLD tile contract.
//! No external crate, game source, borrowed game code, JS callback, or WASI import.
use std::ops::Range;

pub const ABI_VERSION: u32 = 1;
pub const FILE_LIMIT: usize = 64 * 1024 * 1024;
pub const TILE_LIMIT: u64 = 24_000_000;
pub const REGION_LIMIT: usize = 65_536;
pub const CELL_BYTES: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum Error {
    Truncated = 1, FileBudget, Version, Magic, FileType, Sections, FrameTable,
    HeaderMismatch, StringLength, Dimensions, TileType, NegativeRle,
    CrossColumn, TileLength, Rectangle, RegionBudget, Allocation, NotOpen,
}
pub type Result<T> = std::result::Result<T, Error>;

struct Reader<'a> { bytes: &'a [u8], pos: usize, end: usize }
impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        let end = self.pos.checked_add(n).ok_or(Error::Truncated)?;
        if end > self.end || end > self.bytes.len() { return Err(Error::Truncated); }
        let value = &self.bytes[self.pos..end]; self.pos = end; Ok(value)
    }
    fn u8(&mut self) -> Result<u8> { Ok(self.take(1)?[0]) }
    fn u16(&mut self) -> Result<u16> { let b = self.take(2)?; Ok(u16::from_le_bytes([b[0], b[1]])) }
    fn i16(&mut self) -> Result<i16> { Ok(self.u16()? as i16) }
    fn i32(&mut self) -> Result<i32> { let b = self.take(4)?; Ok(i32::from_le_bytes(b.try_into().unwrap())) }
    fn f64(&mut self) -> Result<f64> { let b = self.take(8)?; Ok(f64::from_le_bytes(b.try_into().unwrap())) }
    fn string_range(&mut self) -> Result<Range<usize>> {
        let mut len = 0_u64;
        for shift in (0..35).step_by(7) {
            let b = self.u8()?;
            len += ((b & 127) as u64) << shift;
            if b & 128 == 0 {
                if len > 4096 { return Err(Error::StringLength); }
                let start = self.pos; self.take(len as usize)?;
                return Ok(start..self.pos);
            }
        }
        Err(Error::StringLength)
    }
}

#[derive(Debug)]
pub struct World {
    pub version: u32, pub width: u32, pub height: u32, pub id: i32,
    pub records: u32, pub name: Range<usize>, pub seed: Range<usize>,
    pub world_surface: Option<f64>, pub sections: Vec<u32>,
    pub important: Vec<u8>, pub columns: Vec<u32>,
}

/// The output is explicit little-endian bytes, never Rust struct layout.
/// bytes 0..2: flags, 2..4 type, 4..8 signed frame x/y, 8..10 wall,
/// 10 paint, 11 wall paint, 12 liquid, 13 liquid kind, 14 shape,
/// 15 canonical record length, 16..32 canonical record and zero padding.
fn record(r: &mut Reader<'_>, important: &[u8], pack: bool) -> Result<(u32, [u8; CELL_BYTES])> {
    let start = r.pos;
    let h1 = r.u8()?;
    let h2 = if h1 & 1 != 0 { r.u8()? } else { 0 };
    let h3 = if h2 & 1 != 0 { r.u8()? } else { 0 };
    let h4 = if h3 & 1 != 0 { r.u8()? } else { 0 };
    let active = h1 & 2 != 0;
    let mut kind = 0; let mut frame = None; let mut paint = 0;
    if active {
        kind = if h1 & 32 != 0 { r.u16()? } else { r.u8()? as u16 };
        let framed = important.get(kind as usize).ok_or(Error::TileType)?;
        if *framed != 0 { frame = Some((r.i16()?, r.i16()?)); }
        if h3 & 8 != 0 { paint = r.u8()?; }
    }
    let mut wall = 0_u16; let mut wall_paint = 0;
    if h1 & 4 != 0 {
        wall = r.u8()? as u16;
        if h3 & 16 != 0 { wall_paint = r.u8()?; }
    }
    let mut liquid_kind = (h1 >> 3) & 3;
    let liquid = if liquid_kind != 0 { r.u8()? } else { 0 };
    if liquid_kind != 0 && h3 & 128 != 0 { liquid_kind = 4; }
    if h3 & 64 != 0 { wall |= (r.u8()? as u16) << 8; }
    let raw_end = r.pos;
    let repeats = match h1 >> 6 {
        0 => 0,
        1 => r.u8()? as u32,
        _ => { let n = r.i16()?; if n < 0 { return Err(Error::NegativeRle); } n as u32 },
    };
    let mut cell = [0; CELL_BYTES];
    if pack {
        let mut flags = active as u16;
        for (set, bit) in [
            (h2 & 2 != 0, 1), (h2 & 4 != 0, 2), (h2 & 8 != 0, 3),
            (h3 & 32 != 0, 4), (h3 & 2 != 0, 5), (h3 & 4 != 0, 6),
            (h4 & 2 != 0, 7), (h4 & 4 != 0, 8), (h4 & 8 != 0, 9),
            (h4 & 16 != 0, 10), (frame.is_some(), 11),
        ] { if set { flags |= 1 << bit; } }
        cell[0..2].copy_from_slice(&flags.to_le_bytes());
        cell[2..4].copy_from_slice(&kind.to_le_bytes());
        if let Some((x, y)) = frame {
            cell[4..6].copy_from_slice(&x.to_le_bytes());
            cell[6..8].copy_from_slice(&y.to_le_bytes());
        }
        cell[8..10].copy_from_slice(&wall.to_le_bytes());
        cell[10] = paint; cell[11] = wall_paint; cell[12] = liquid;
        cell[13] = liquid_kind; cell[14] = (h2 >> 4) & 7;
        let len = raw_end - start;
        if len > 16 { return Err(Error::TileLength); }
        cell[15] = len as u8;
        cell[16..16 + len].copy_from_slice(&r.bytes[start..raw_end]);
        cell[16] &= 63;
    }
    Ok((repeats + 1, cell))
}

impl World {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > FILE_LIMIT { return Err(Error::FileBudget); }
        let mut r = Reader { bytes, pos: 0, end: bytes.len() };
        let version = r.i32()?;
        if !(269..=326).contains(&version) { return Err(Error::Version); }
        let magic = r.take(7)?;
        if magic != b"relogic" && magic != b"xindong" { return Err(Error::Magic); }
        if r.u8()? != 2 { return Err(Error::FileType); }
        r.take(12)?;
        let count = r.u16()? as usize;
        if !(3..=32).contains(&count) { return Err(Error::Sections); }
        let mut sections = Vec::with_capacity(count);
        for _ in 0..count { sections.push(r.i32()?); }
        for (i, &offset) in sections.iter().enumerate() {
            if offset < r.pos as i32 || offset as usize > bytes.len() || (i > 0 && offset < sections[i - 1]) {
                return Err(Error::Sections);
            }
        }
        let sections: Vec<u32> = sections.into_iter().map(|n| n as u32).collect();
        let types = r.u16()? as usize;
        if !(1..=4096).contains(&types) { return Err(Error::FrameTable); }
        let mut important = vec![0; types]; let mut bits = 0;
        for (i, item) in important.iter_mut().enumerate() {
            if i % 8 == 0 { bits = r.u8()?; }
            *item = ((bits & (1 << (i % 8))) != 0) as u8;
        }
        if r.pos != sections[0] as usize { return Err(Error::HeaderMismatch); }
        r.end = sections[1] as usize;
        let name = r.string_range()?; let seed = r.string_range()?;
        r.take(24)?; let id = r.i32()?; r.take(16)?;
        let height = r.i32()?; let width = r.i32()?;
        if width <= 0 || height <= 0 || width > 10000 || height > 5000 || (width as u64) * (height as u64) > TILE_LIMIT {
            return Err(Error::Dimensions);
        }
        let skip = 4 + if version >= 302 { 9 } else { 8 } + 8 + if version >= 284 { 8 } else { 0 } + 1 + 68 + 8;
        let world_surface = if r.pos + skip + 8 <= r.end {
            r.take(skip)?; let value = r.f64()?;
            if value.is_finite() && value >= 0.0 && value <= height as f64 { Some(value) } else { None }
        } else { None };
        r.pos = sections[1] as usize; r.end = sections[2] as usize;
        let mut columns = Vec::with_capacity(width as usize + 1);
        let mut records = 0;
        for _ in 0..width {
            columns.push(r.pos as u32); let mut y = 0;
            while y < height as u32 {
                let (run, _) = record(&mut r, &important, false)?;
                y += run;
                if y > height as u32 { return Err(Error::CrossColumn); }
                records += 1;
            }
        }
        columns.push(r.pos as u32);
        if r.pos != r.end { return Err(Error::TileLength); }
        Ok(Self { version: version as u32, width: width as u32, height: height as u32,
            id, name, seed, world_surface, sections, important, columns, records })
    }

    pub fn extract(&self, bytes: &[u8], x: u32, y: u32, width: u32, height: u32, output: &mut Vec<u8>) -> Result<()> {
        // Erase old output even on error: a failed request cannot expose stale output.
        output.clear();
        if width == 0 || height == 0 || x.checked_add(width).filter(|n| *n <= self.width).is_none()
            || y.checked_add(height).filter(|n| *n <= self.height).is_none() { return Err(Error::Rectangle); }
        if width > 512 || height > 512 || width as u64 * height as u64 > REGION_LIMIT as u64 {
            return Err(Error::RegionBudget);
        }
        let needed = width as usize * height as usize * CELL_BYTES;
        output.try_reserve(needed).map_err(|_| Error::Allocation)?;
        let mut r = Reader { bytes, pos: 0, end: self.sections[2] as usize };
        for xx in x..x + width {
            r.pos = self.columns[xx as usize] as usize;
            r.end = self.columns[xx as usize + 1] as usize;
            let mut yy = 0;
            while yy < y + height {
                let (run, cell) = record(&mut r, &self.important, true)?;
                let end = yy + run;
                if end > self.height { return Err(Error::CrossColumn); }
                for _ in yy.max(y)..end.min(y + height) { output.extend_from_slice(&cell); }
                yy = end;
            }
        }
        if output.len() != needed { output.clear(); return Err(Error::TileLength); }
        Ok(())
    }
}

#[cfg(target_arch = "wasm32")]
mod abi {
    use super::*;
    use std::cell::RefCell;
    #[derive(Default)]
    struct State { input: Vec<u8>, world: Option<World>, output: Vec<u8>, error: u32, meta: [u32; 13] }
    thread_local! { static STATE: RefCell<State> = RefCell::new(State::default()); }
    #[no_mangle] pub extern "C" fn abi_version() -> u32 { ABI_VERSION }
    #[no_mangle] pub extern "C" fn cell_bytes() -> u32 { CELL_BYTES as u32 }
    #[no_mangle] pub extern "C" fn last_error() -> u32 { STATE.with(|s| s.borrow().error) }
    // Buffer ownership never crosses the ABI. JS can write only the returned input
    // range. Rust receives lengths/coordinates, never caller-controlled pointers.
    #[no_mangle] pub extern "C" fn prepare(len: u32) -> u32 {
        STATE.with(|state| {
            let mut s = state.borrow_mut();
            *s = State::default();
            if len as usize > FILE_LIMIT { s.error = Error::FileBudget as u32; return 0; }
            if s.input.try_reserve_exact(len as usize).is_err() { s.error = Error::Allocation as u32; return 0; }
            s.input.resize(len as usize, 0); s.input.as_mut_ptr() as u32
        })
    }
    #[no_mangle] pub extern "C" fn open_world() -> u32 {
        STATE.with(|state| {
            let mut s = state.borrow_mut(); s.world = None; s.output.clear(); s.meta = [0; 13];
            match World::parse(&s.input) {
                Ok(w) => {
                    s.meta = [w.version, w.width, w.height, w.id as u32, w.records,
                        w.name.start as u32, w.name.len() as u32, w.seed.start as u32,
                        w.seed.len() as u32, w.sections.len() as u32, w.important.len() as u32,
                        w.columns.len() as u32, CELL_BYTES as u32];
                    s.world = Some(w); s.error = 0; 0
                }
                Err(e) => { s.error = e as u32; e as u32 }
            }
        })
    }
    #[no_mangle] pub extern "C" fn extract_region(x: u32, y: u32, w: u32, h: u32) -> u32 {
        STATE.with(|state| {
            let mut s = state.borrow_mut();
            let State { input, world, output, error, .. } = &mut *s;
            let result = world.as_ref().ok_or(Error::NotOpen).and_then(|world| world.extract(input, x, y, w, h, output));
            *error = match result { Ok(()) => 0, Err(e) => { output.clear(); e as u32 } }; *error
        })
    }
    #[no_mangle] pub extern "C" fn meta_ptr() -> u32 { STATE.with(|s| s.borrow().meta.as_ptr() as u32) }
    #[no_mangle] pub extern "C" fn columns_ptr() -> u32 { STATE.with(|s| s.borrow().world.as_ref().map_or(0, |w| w.columns.as_ptr() as u32)) }
    #[no_mangle] pub extern "C" fn important_ptr() -> u32 { STATE.with(|s| s.borrow().world.as_ref().map_or(0, |w| w.important.as_ptr() as u32)) }
    #[no_mangle] pub extern "C" fn sections_ptr() -> u32 { STATE.with(|s| s.borrow().world.as_ref().map_or(0, |w| w.sections.as_ptr() as u32)) }
    #[no_mangle] pub extern "C" fn world_surface() -> f64 { STATE.with(|s| s.borrow().world.as_ref().and_then(|w| w.world_surface).unwrap_or(f64::NAN)) }
    #[no_mangle] pub extern "C" fn output_ptr() -> u32 { STATE.with(|s| s.borrow().output.as_ptr() as u32) }
    #[no_mangle] pub extern "C" fn output_len() -> u32 { STATE.with(|s| s.borrow().output.len() as u32) }
    #[no_mangle] pub extern "C" fn release() { STATE.with(|s| *s.borrow_mut() = State::default()); }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn detects_short_header() { assert_eq!(World::parse(&[0, 1, 2]).unwrap_err(), Error::Truncated); }
    #[test] fn detects_version_before_allocation() { assert_eq!(World::parse(&268_i32.to_le_bytes()).unwrap_err(), Error::Version); }
    #[test] fn negative_and_alternate_runs() {
        let important = [0; 2];
        let mut r = Reader { bytes: &[0xC2, 1, 0xFF, 0xFF], pos: 0, end: 4 };
        assert_eq!(record(&mut r, &important, true).unwrap_err(), Error::NegativeRle);
        let mut r = Reader { bytes: &[0xC2, 1, 2, 0], pos: 0, end: 4 };
        let (run, cell) = record(&mut r, &important, true).unwrap();
        assert_eq!(run, 3); assert_eq!(&cell[16..18], &[2, 1]);
    }
    #[test] fn reserved_header_bytes_and_signed_frames_survive() {
        let mut important = [0; 512]; important[300] = 1;
        let bytes = [0x23, 0x81, 0x01, 0x80, 0x2C, 0x01, 0xFE, 0xFF, 0x44, 0x01];
        let mut r = Reader { bytes: &bytes, pos: 0, end: bytes.len() };
        let (_, cell) = record(&mut r, &important, true).unwrap();
        assert_eq!(&cell[4..8], &[0xFE, 0xFF, 0x44, 0x01]);
        assert_eq!(&cell[16..26], &bytes);
    }
}
