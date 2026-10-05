export const ASSET_LIMITS = Object.freeze({
  encodedBytes: 8 * 1024 * 1024,
  decodedBytes: 16 * 1024 * 1024,
  cacheBytes: 48 * 1024 * 1024,
  count: 256,
});
export function inspectPng(bytes) {
  if (bytes.length < 24 || bytes.length > ASSET_LIMITS.encodedBytes)
    throw new Error("PNG encoded size outside budget");
  const magic = [137, 80, 78, 71, 13, 10, 26, 10];
  if (
    magic.some((b, i) => bytes[i] !== b) ||
    String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR"
  )
    throw new Error("Invalid PNG header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    width = view.getUint32(16),
    height = view.getUint32(20),
    decodedBytes = width * height * 4;
  if (
    !width ||
    !height ||
    width > 4096 ||
    height > 4096 ||
    decodedBytes > ASSET_LIMITS.decodedBytes
  )
    throw new Error("PNG decoded dimensions exceed budget");
  return { width, height, decodedBytes };
}

// Weak ownership ties raw import bytes to the decoded platform image lifetime.
const textureSources = new WeakMap();
export function registerTextureSource(
  image,
  { pngBytes, rawRgba = null, rawError = null },
) {
  const width = image.naturalWidth ?? image.width,
    height = image.naturalHeight ?? image.height;
  if (
    !(pngBytes instanceof Uint8Array) ||
    pngBytes.byteLength > ASSET_LIMITS.encodedBytes
  )
    throw new Error("Invalid texture source bytes");
  if (
    rawRgba &&
    (rawRgba.width !== width ||
      rawRgba.height !== height ||
      rawRgba.data.length !== width * height * 4)
  )
    throw new Error("Raw PNG dimensions differ from platform image");
  textureSources.set(image, { pngBytes, rawRgba, rawError });
  return image;
}
export const textureSource = (image) => textureSources.get(image);
export function textureMemoryBytes(image) {
  const source = textureSource(image);
  return (
    (image.naturalWidth ?? image.width) *
      (image.naturalHeight ?? image.height) *
      4 +
    (source?.pngBytes.byteLength || 0) +
    (source?.rawRgba?.data.byteLength || 0)
  );
}
