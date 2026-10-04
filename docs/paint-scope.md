# Paint support and evidence

This module is an original numeric implementation, not redistributed Terraria source,
shader bytecode, or texture data. It supports paint IDs 0–31 and a bounded subset of
material-specific masks. It does **not** claim pixel-identical GPU rendering.

## Evidence

The source contract is pinned to
[8255d34616c780af12079425ac92a0a7aed87d71](https://github.com/Live-yum/TerrariaDecompiledSource/tree/8255d34616c780af12079425ac92a0a7aed87d71):

- [Paint IDs](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.ID/PaintID.cs#L5-L69)
- [Effect pass selection](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria/Main.cs#L59624-L59644)
- [Texture preparation and mask uniforms](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.GameContent/TilePaintSystemV2.cs#L31-L81)
- [Dirt/mud settings](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.GameContent/TreePaintSystemData.cs#L16-L35)
- [Tile routing](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.GameContent/TreePaintSystemData.cs#L252-L323)
- [Wall settings](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.GameContent/TreePaintSystemData.cs#L399-L402)

C# exposes the effect dependency and parameters, not pixel arithmetic. An authorized
private Windows TileShader asset was independently decompressed and statically
analyzed; its SHA-256 is
`7f8bbee3b688b80f661143de65ac38ae2114060e4c0fa44af39f4ec32a7bf602`.
Its one technique has 45 explicitly mapped shader passes and the six expected
mask uniforms. The C# paint selector uses passes 0–43; extra pass 44 is unused by
valid paint IDs. No game executable or native shader was run. A private bounded
arithmetic evaluator checked 86,480 synthetic cases against the recovered formulas,
maximum normalized-channel error below 1.6e-8. This is CPU arithmetic evidence,
not a GPU image oracle. Public tests contain only original synthetic samples.

## API

`paintPixelRGBA(bytes4, paintId, options)` returns a new `Uint8ClampedArray`.
It never mutates input. Unsupported operations throw `UnsupportedPaintError`
with a stable `reason` string. Bad RGBA data throws `TypeError`.

Options:

- `wall: false`: use true for the distinct negative-wall pass
- `specialSettings: null`: or `{minHue,maxHue,minSat,maxSat,hueOffset,invert}`
- `alphaMode: "opaque-only"`: alternatives below
- `inputEncoding: "standard-straight"`: alternatively `"tconvert-game-raw"`

`supportsPaint(id)` checks the ID range only, not material/alpha support.
`resolvePaintSettings(tileType, {paintId,wall})` (alias `resolvePaintStyle`)
returns `{supported:true,specialSettings}` or `{supported:false,reason}`.
The caller must honor the support flag before painting; do not pass an unsupported
result and silently render an unmasked substitute.

Ordinary paint on dirt-related types 0,2,23,109,199,477,492,633 uses the inverted
dirt hue/saturation mask. Types 59,60,70 use the shifted/inverted mud mask.
Walls and default materials have no selective mask. Ordinary paints on tree,
palm, gem-tree and vanity-tree types return `tree-paint-style`; their runtime
style/biome routing is outside this module. Deep and special paints bypass masks.

## Formulas

For normalized sampled RGB let `H=max(R,G,B)` and `L=min(R,G,B)`.
IDs 1–12 follow red, orange, yellow, lime, green, teal, cyan, sky blue, blue,
purple, violet, pink. Their high/low channels are `H,L`; intermediate channels
are `(H+L)/2`. IDs 13–24 use the same pattern with low channel `0.4*L` and
intermediate `(H+0.4*L)/2`.

| ID               | Result before target clamping                    |
| ---------------- | ------------------------------------------------ |
| 25 black         | Each RGB channel `0.15*(H+L)`                    |
| 26 white         | Each channel `((7*H+3*L)*0.1)*(2-0.5*(H+L))`     |
| 27 gray          | Each channel `0.5*(H+L)`                         |
| 28 brown         | `H*(1,0.7,0.49)`                                 |
| 29 shadow        | Each channel `0.025*(H+L)`                       |
| 30 negative tile | Black stays black; otherwise `1-RGB`             |
| 30 negative wall | Black stays black; otherwise `max(0,0.75-2*RGB)` |
| 0 / 31           | Identity                                         |

Selective ordinary paint computes HSV, with achromatic hue/saturation zero,
then applies inclusive hue and saturation bounds. Hue offset uses signed
remainder modulo one; inversion flips inclusion. Excluded samples remain original.
The shader does not perform gamma conversion or unpremultiply sampled RGB.
Its alpha stays unchanged. The preparation pass uses white vertex tint.

Shader constants are represented as their float32 values, but this implementation
uses JavaScript arithmetic. Output is explicitly clamped to [0,1], multiplied by
255, and rounded to nearest byte (`Math.round`). GPU intermediate precision,
render-target quantization and mask-edge behavior may differ at boundary values.
`WorldGen.paintColor` and minimap coloring are not the scene-paint formulas.

## Alpha is an explicit contract

The original preparation target uses XNA premultiplied alpha blending. Canvas
ImageData uses straight (unassociated) RGBA. A PNG filename alone proves neither
its conversion history nor equivalence to the original XNB sample values.

- `opaque-only` (default) accepts opaque samples and canonicalizes fully transparent
  painted samples to `[0,0,0,0]`. Nonidentity paint on A=1–254 throws
  `semitransparent-alpha-provenance`.
- `straight` with `inputEncoding: "standard-straight"` is an explicit request to model a straight-RGBA input by premultiplying,
  applying paint, clamping the target, then unpremultiplying for straight output.
  Do not use it as a claim that the input asset's provenance has been verified.
- `straight` with `inputEncoding: "tconvert-game-raw"` feeds stored RGB directly
  to the shader math, then checks representability and unpremultiplies for Canvas.
  There is no initial multiplication by alpha. TConvert's XnbExtractor copies
  decoded texture bytes (with R/B channel swapping) into its PNG without
  unpremultiplication; those PNG channels retain the game texture's association.
  Treating them as standard straight RGBA and multiplying again changes shader input.
  This adapter also converts identity paints 0/31 when explicitly requested.
  It cannot establish provenance for PNGs from another exporter.
- Some white/negative results have premultiplied RGB greater than alpha. Straight
  RGBA cannot preserve these colors for later blending. `straight` throws
  `paint-exceeds-alpha` rather than clipping silently or inventing an approximation.
  The caller must report/skip that painted frame, not render an unpainted fallback
  as if it were successfully painted.
- `premultiplied` accepts raw premultiplied source bytes and returns shader-domain
  target bytes. Output RGB may exceed alpha; this is **not** Canvas ImageData.
  Input channels greater than alpha are rejected (fully transparent samples are
  canonicalized first). Identity returns an unchanged copy in raw-output mode.

A=0 is transparent black for nonidentity paint in every mode. Identity IDs preserve
input hidden channels except when raw-to-straight conversion is explicitly requested;
they never imply any coating. Linear/homogeneous paint families
round-trip straight alpha naturally; white and negative require the checks above.
The adapter does not reconstruct the exporter's original XNB quantization or add
an intermediate 8-bit rounding step before unpremultiplication. Only final output
rounding is specified. No sampler interpolation, background compositing or lighting
is implemented here. Asset encoding must also be handled consistently for unpainted
texture draws; correcting painted crops alone does not correct the rest of the atlas.

## Coatings and legacy illuminant

31 selects identity; the paint function never invents glow. For world versions below
258, the game's loader separately converts legacy paint31 to paint0 plus a fullbright
block/wall flag ([gate](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.IO/WorldFile.cs#L1860-L1865),
[conversion](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.IO/WorldFile.cs#L2818-L2837)).
Glow/echo are independent draw/visibility flags. Glow changes light tint to white,
not this RGB formula. Echo needs viewer/monolith context. Runtime lighting, transient
shine and special tile drawing are separate concerns.

## Scene compositing adapter

The optional scene-premultiplied mode returns shader-domain RGBA, retaining RGB greater than alpha. The scene adapter decomposes each sample into source-over `(min(P,A),A)` and an additive remainder `max(P-A,0)`. It draws those terms in place on one opaque scene buffer, keeping wall/liquid/Tile ordering. It does not flatten individual sprites on black. Transparent mode rejects an unrepresentable remainder instead of clipping it silently. Eight-bit Canvas association introduces quantization; compositing tests allow at most two byte levels, not a claim of GPU bit identity.

Input channel association is an explicit contract: standard straight PNGs are premultiplied before shader math; a converter that preserves sampled game channels must use raw-game mode, without multiplying them twice. The latter applies to unpainted frames too. PNG decoding cannot recover nonzero hidden RGB at alpha zero; GPU texture-byte parity is not established by this adapter.

Raw-channel fidelity is limited before shader math: Canvas readback can heavily quantize very low-alpha RGB (native regression: `[60,30,15,1]` becomes `[0,0,0,1]`), and drops hidden RGB at alpha zero. This can exceed a one-byte rounding error. Exact raw preservation would require a bounded raw PNG decoder rather than image-to-Canvas readback. Independent 500 seeded eight-layer stacks remained opaque, with up to 5.69 channel-byte deviation from floating-point sequential math; the two-byte tolerance above is for the focused short stacks only. The renderer needs a dedicated normal-transform scene canvas; it restores drawing state but replaces the current path.
