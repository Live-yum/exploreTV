/*
 * Exact, bounded RGBA area reduction through Node-API.
 *
 * No image is copied into the addon: Node keeps the typed-array arguments alive
 * for this synchronous call. The only allocation is the reduced output Buffer.
 * All sums fit in uint32_t: 16*16*255*255 < 2^24. Integer rounding implements
 * Math.round for these nonnegative ratios, including alpha and tie cases.
 */
#include <node_api.h>
#include <math.h>
#include <stdint.h>
#include <stddef.h>

#if defined(__linux__) && defined(__GLIBC__)
#include <malloc.h>
#define EXPLORETV_HAS_MALLOC_TRIM 1
#else
#define EXPLORETV_HAS_MALLOC_TRIM 0
#endif

static napi_value fail(napi_env env, const char *message) {
  napi_throw_range_error(env, NULL, message);
  return NULL;
}

static int u32(napi_env env, napi_value value, uint32_t *result) {
  double number;
  if (napi_get_value_double(env, value, &number) != napi_ok ||
      !isfinite(number) || number < 0 || number > UINT32_MAX ||
      floor(number) != number) return 0;
  *result = (uint32_t)number;
  return 1;
}

static int bytes(napi_env env, napi_value value, uint8_t **data, size_t *length) {
  napi_typedarray_type type;
  napi_value arraybuffer;
  size_t offset;
  void *pointer;
  if (napi_get_typedarray_info(env, value, &type, length, &pointer,
                              &arraybuffer, &offset) != napi_ok ||
      (type != napi_uint8_array && type != napi_uint8_clamped_array)) return 0;
  *data = (uint8_t *)pointer;
  return *length == 0 || pointer != NULL;
}

static napi_value downsample_rgba(napi_env env, napi_callback_info info) {
  size_t argc = 10;
  napi_value args[10];
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok ||
      (argc != 4 && argc != 9))
    return fail(env, "Native RGBA reduction requires four or nine arguments");
  uint8_t *source, *safe = NULL, *known = NULL;
  size_t source_length, safe_length = 0, known_length = 0;
  uint32_t width, height, factor, tile_stride = 0, offset_x = 0, offset_y = 0;
  if (!bytes(env, args[0], &source, &source_length) ||
      !u32(env, args[1], &width) || !u32(env, args[2], &height) ||
      !u32(env, args[3], &factor) || width == 0 || height == 0 ||
      factor == 0 || factor > 16 || width % factor || height % factor ||
      source_length % 4 || (uint64_t)width * height != source_length / 4)
    return fail(env, "Invalid RGBA area-reduction dimensions or byte array");
  const uint32_t out_width = width / factor, out_height = height / factor;
  if (argc == 9) {
    if (factor != 16 || !bytes(env, args[4], &safe, &safe_length) ||
        !bytes(env, args[5], &known, &known_length) ||
        !u32(env, args[6], &tile_stride) || tile_stride == 0 ||
        !u32(env, args[7], &offset_x) || !u32(env, args[8], &offset_y) ||
        safe_length == 0 || safe_length % tile_stride ||
        known_length % 4 || safe_length != known_length / 4 ||
        (uint64_t)offset_x + out_width > tile_stride ||
        (uint64_t)offset_y + out_height > safe_length / tile_stride)
      return fail(env, "Invalid native opaque overview mask");
  }
  const size_t result_length = (size_t)out_width * out_height * 4;
  uint8_t *output;
  napi_value result;
  if (napi_create_buffer(env, result_length, (void **)&output, &result) != napi_ok)
    return NULL;
  const uint32_t samples = factor * factor;
  for (uint32_t y = 0; y < out_height; y++) {
    for (uint32_t x = 0; x < out_width; x++) {
      const size_t destination = ((size_t)y * out_width + x) * 4;
      if (safe != NULL) {
        const size_t tile = ((size_t)y + offset_y) * tile_stride + x + offset_x;
        if (safe[tile]) {
          output[destination] = known[tile * 4];
          output[destination + 1] = known[tile * 4 + 1];
          output[destination + 2] = known[tile * 4 + 2];
          output[destination + 3] = known[tile * 4 + 3];
          continue;
        }
      }
      uint32_t red = 0, green = 0, blue = 0, alpha = 0;
      for (uint32_t sy = 0; sy < factor; sy++) {
        const uint8_t *row = source +
          (((size_t)y * factor + sy) * width + (size_t)x * factor) * 4;
        for (uint32_t sx = 0; sx < factor; sx++) {
          const uint32_t a = row[sx * 4 + 3];
          red += row[sx * 4] * a;
          green += row[sx * 4 + 1] * a;
          blue += row[sx * 4 + 2] * a;
          alpha += a;
        }
      }
      if (alpha) {
        output[destination] = (uint8_t)((red + alpha / 2) / alpha);
        output[destination + 1] = (uint8_t)((green + alpha / 2) / alpha);
        output[destination + 2] = (uint8_t)((blue + alpha / 2) / alpha);
      } else {
        output[destination] = output[destination + 1] = output[destination + 2] = 0;
      }
      output[destination + 3] = (uint8_t)((alpha + samples / 2) / samples);
    }
  }
  return result;
}

/*
 * Explicit, process-wide allocator maintenance. This does not collect JS
 * objects or free any live allocation: glibc only returns already-free pages
 * to the OS. A return of 1 reports that some memory was released, not its size
 * or a guaranteed decrease in the process RSS. Unsupported allocators return
 * -1 and perform no action. Callers choose the cadence after finalizers run;
 * frequent trimming can add allocator locking and later page-fault overhead.
 */
static napi_value trim_native_memory(napi_env env, napi_callback_info info) {
  (void)info;
  int result = -1;
#if EXPLORETV_HAS_MALLOC_TRIM
  result = malloc_trim(0) ? 1 : 0;
#endif
  napi_value value;
  if (napi_create_int32(env, result, &value) != napi_ok) return NULL;
  return value;
}

static napi_value initialize(napi_env env, napi_value exports) {
  napi_value function, trim_function, trim_available;
  if (napi_create_function(env, "downsampleRgba", NAPI_AUTO_LENGTH,
                           downsample_rgba, NULL, &function) != napi_ok ||
      napi_set_named_property(env, exports, "downsampleRgba", function) != napi_ok ||
      napi_create_function(env, "trimNativeMemory", NAPI_AUTO_LENGTH,
                           trim_native_memory, NULL, &trim_function) != napi_ok ||
      napi_set_named_property(env, exports, "trimNativeMemory", trim_function) != napi_ok ||
      napi_get_boolean(env, EXPLORETV_HAS_MALLOC_TRIM, &trim_available) != napi_ok ||
      napi_set_named_property(env, exports, "nativeMemoryTrimAvailable", trim_available) != napi_ok)
    return NULL;
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
