import { decodePngRgba } from "../core/png-rgba.mjs";
import { inspectPng, registerTextureSource } from "../core/assets.mjs";
import { LIMITS } from "../core/world.mjs";
export async function chooseFiles({ multiple = false, accept = ".wld" } = {}) {
  // #ifdef H5
  return await new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => resolve(Array.from(input.files || []));
    input.oncancel = () => resolve([]);
    input.click();
  });
  // #endif
  // #ifdef MP-WEIXIN
  return await new Promise((resolve, reject) =>
    wx.chooseMessageFile({
      count: multiple ? 100 : 1,
      type: "file",
      success: (r) => resolve(r.tempFiles),
      fail: (e) =>
        String(e.errMsg).includes("cancel") ? resolve([]) : reject(e),
    }),
  );
  // #endif
}
export async function readBytes(file, maxBytes = LIMITS.fileBytes) {
  if (file.size > maxBytes) throw new Error("文件超出大小限制");
  // #ifdef H5
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error("文件超出大小限制");
  return bytes;
  // #endif
  // #ifdef MP-WEIXIN
  return await new Promise((resolve, reject) =>
    wx.getFileSystemManager().readFile({
      filePath: file.path,
      success: (r) => {
        const bytes = new Uint8Array(r.data);
        bytes.length > maxBytes
          ? reject(new Error("文件超出大小限制"))
          : resolve(bytes);
      },
      fail: reject,
    }),
  );
  // #endif
}
export async function saveText(text, name) {
  // #ifdef H5
  const url = URL.createObjectURL(
    new Blob([text], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return name;
  // #endif
  // #ifdef MP-WEIXIN
  const path = `${wx.env.USER_DATA_PATH}/${name}`;
  await new Promise((resolve, reject) =>
    wx.getFileSystemManager().writeFile({
      filePath: path,
      data: text,
      encoding: "utf8",
      success: resolve,
      fail: reject,
    }),
  );
  return path;
  // #endif
}
export async function loadTexture(file, canvas) {
  const pngBytes = await readBytes(file, 8 * 1024 * 1024);
  const info = inspectPng(pngBytes);
  let rawRgba = null,
    rawError = null;
  try {
    rawRgba = decodePngRgba(pngBytes);
  } catch (error) {
    rawError = "raw-png-unsupported: " + error.message;
  }
  return await new Promise((resolve, reject) => {
    let image,
      url,
      settled = false;
    // #ifdef H5
    image = new Image();
    url = URL.createObjectURL(file);
    // #endif
    // #ifdef MP-WEIXIN
    image = canvas.createImage();
    url = file.path;
    // #endif
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
      // #ifdef H5
      URL.revokeObjectURL(url);
      // #endif
      error
        ? reject(error)
        : resolve(
            registerTextureSource(image, { pngBytes, rawRgba, rawError }),
          );
    };
    const timer = setTimeout(
      () => finish(new Error("PNG 贴图解码超时")),
      15000,
    );
    image.onload = () =>
      finish(
        image.width !== info.width || image.height !== info.height
          ? new Error("PNG 解码尺寸与文件头不符")
          : null,
      );
    image.onerror = () => finish(new Error("PNG 贴图解码失败"));
    try {
      image.src = url;
    } catch (error) {
      finish(error);
    }
  });
}

export function createProcessingCanvas(width, height) {
  // #ifdef H5
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
  // #endif
  // #ifdef MP-WEIXIN
  if (typeof wx.createOffscreenCanvas === "function")
    return wx.createOffscreenCanvas({ type: "2d", width, height });
  const error = new Error("Offscreen Canvas 2D unavailable");
  error.reason = "offscreen-canvas-unavailable";
  throw error;
  // #endif
}
