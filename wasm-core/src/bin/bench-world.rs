use exploretv_wld_core::World;
use std::{env, fs, hint::black_box, time::Instant};
fn main() {
    let path = env::args().nth(1).expect("usage: bench-world PATH.wld");
    let bytes = fs::read(path).expect("read world");
    let mut open_ms = Vec::new();
    for _ in 0..9 {
        let start = Instant::now();
        let world = World::parse(black_box(&bytes)).expect("valid world");
        black_box(world.records);
        open_ms.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    let world = World::parse(&bytes).unwrap();
    println!("{{\"runtime\":\"native-rust\",\"includesFileIO\":false,\"includesJsConversion\":false,\"fileBytes\":{},\"records\":{},\"openMs\":{:?},\"regions\":[", bytes.len(), world.records, open_ms);
    for (index, (x, y, width, height)) in [(4000,400,128,128), (2000,1000,256,256), (7000,2100,128,128)].into_iter().enumerate() {
        let mut output = Vec::new(); let mut ms = Vec::new();
        for _ in 0..15 {
            let start = Instant::now();
            world.extract(&bytes, x, y, width, height, &mut output).unwrap();
            black_box(&output); ms.push(start.elapsed().as_secs_f64() * 1000.0);
        }
        if index > 0 { print!(","); }
        println!("{{\"rect\":{{\"x\":{},\"y\":{},\"width\":{},\"height\":{}}},\"ms\":{:?}}}", x,y,width,height,ms);
    }
    println!("]}}");
}
