#include <node_api.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#if defined(__SSE2__) && !defined(EXPLORETV_FORCE_SCALAR)
#include <emmintrin.h>
#define BLITTER_SSE2 1
#endif

/*
 * Exact integer-pixel composition for an opaque RGBA8 target. Prepared Canvas
 * frames are read once and converted back to Skia's premultiplied byte domain.
 * Each descriptor contains frame, width, height, x, y, flipX, flipY, blend.
 * Blend 0 is source-over; blend 1 is saturating additive composition.
 * No pixel allocation, per-sprite Canvas transitions, or persistent native state.
 */
#define DESCRIPTOR_SIZE 8
#define MAX_FRAMES 8192
#define MAX_COMMANDS 262144

typedef struct {
  uint8_t *data;
  size_t length;
} bytes;

static napi_value fail(napi_env env, const char *message) {
  napi_throw_type_error(env, NULL, message);
  return NULL;
}

static bool get_bytes(napi_env env, napi_value value, bytes *result) {
  bool typed = false, array_buffer = false, detached = false;
  napi_typedarray_type type;
  napi_value buffer;
  size_t offset;
  if (napi_is_typedarray(env, value, &typed) != napi_ok || !typed ||
      napi_get_typedarray_info(env, value, &type, &result->length,
                              (void **)&result->data, &buffer, &offset) != napi_ok ||
      napi_is_arraybuffer(env, buffer, &array_buffer) != napi_ok || !array_buffer ||
      napi_is_detached_arraybuffer(env, buffer, &detached) != napi_ok || detached)
    return false;
  return type == napi_uint8_array || type == napi_uint8_clamped_array;
}

static bool get_u32(napi_env env, napi_value value, uint32_t *result) {
  double number;
  if (napi_get_value_double(env, value, &number) != napi_ok ||
      !(number >= 1 && number <= INT32_MAX))
    return false;
  *result = (uint32_t)number;
  return (double)*result == number;
}

static inline uint8_t rounded_product(uint8_t color, uint8_t alpha) {
  /* round(color * alpha / 255), exact for all byte pairs. */
  const unsigned value = (unsigned)color * alpha + 128;
  return (uint8_t)((value + (value >> 8)) >> 8);
}

static inline uint8_t saturated_sum(uint8_t a, uint8_t b) {
  const unsigned sum = (unsigned)a + b;
  return (uint8_t)(sum > 255 ? 255 : sum);
}

#if defined(BLITTER_SSE2)
static inline __m128i repeat_alpha16(__m128i source) {
  source = _mm_shufflelo_epi16(source, _MM_SHUFFLE(3, 3, 3, 3));
  return _mm_shufflehi_epi16(source, _MM_SHUFFLE(3, 3, 3, 3));
}

static inline __m128i rounded_product16(__m128i color, __m128i alpha) {
  __m128i value = _mm_add_epi16(_mm_mullo_epi16(color, alpha), _mm_set1_epi16(128));
  return _mm_srli_epi16(_mm_add_epi16(value, _mm_srli_epi16(value, 8)), 8);
}

static inline __m128i load_pixels4(const uint8_t *source, int64_t sx, bool flip) {
  if (!flip) return _mm_loadu_si128((const __m128i *)(source + (size_t)sx * 4));
  const __m128i pixels = _mm_loadu_si128((const __m128i *)(source + (size_t)(sx - 3) * 4));
  return _mm_shuffle_epi32(pixels, _MM_SHUFFLE(0, 1, 2, 3));
}

static inline __m128i source_over4(__m128i source, __m128i destination) {
  const __m128i zero = _mm_setzero_si128();
  // Match the scalar zero-alpha no-op even for callers with stray transparent RGB.
  const __m128i zero_alpha = _mm_cmpeq_epi32(_mm_srli_epi32(source, 24), zero);
  source = _mm_andnot_si128(zero_alpha, source);
  const __m128i source_lo = _mm_unpacklo_epi8(source, zero);
  const __m128i source_hi = _mm_unpackhi_epi8(source, zero);
  const __m128i inverse_lo = _mm_sub_epi16(_mm_set1_epi16(255), repeat_alpha16(source_lo));
  const __m128i inverse_hi = _mm_sub_epi16(_mm_set1_epi16(255), repeat_alpha16(source_hi));
  const __m128i destination_lo = rounded_product16(_mm_unpacklo_epi8(destination, zero), inverse_lo);
  const __m128i destination_hi = rounded_product16(_mm_unpackhi_epi8(destination, zero), inverse_hi);
  const __m128i result = _mm_adds_epu8(source, _mm_packus_epi16(destination_lo, destination_hi));
  return _mm_or_si128(result, _mm_set1_epi32((int32_t)0xff000000u));
}
#endif

static void source_over_row(uint8_t *target, const uint8_t *source,
                            int64_t source_x, size_t count, bool flip) {
  size_t x = 0;
#if defined(BLITTER_SSE2)
  for (; x + 4 <= count; x += 4) {
    const int64_t sx = flip ? source_x - (int64_t)x : source_x + (int64_t)x;
    const __m128i s = load_pixels4(source, sx, flip);
    const __m128i d = _mm_loadu_si128((const __m128i *)(target + x * 4));
    _mm_storeu_si128((__m128i *)(target + x * 4), source_over4(s, d));
  }
#endif
  for (; x < count; x++) {
    const size_t sx = (size_t)(flip ? source_x - (int64_t)x : source_x + (int64_t)x);
    const uint8_t *s = source + sx * 4;
    uint8_t *t = target + x * 4;
    if (s[3] == 255) {
      t[0] = s[0]; t[1] = s[1]; t[2] = s[2];
    } else if (s[3]) {
      const uint8_t inverse_alpha = 255 - s[3];
      t[0] = saturated_sum(s[0], rounded_product(t[0], inverse_alpha));
      t[1] = saturated_sum(s[1], rounded_product(t[1], inverse_alpha));
      t[2] = saturated_sum(s[2], rounded_product(t[2], inverse_alpha));
    }
    t[3] = 255;
  }
}

static void additive_row(uint8_t *target, const uint8_t *source,
                         int64_t source_x, size_t count, bool flip) {
  size_t x = 0;
#if defined(BLITTER_SSE2)
  for (; x + 4 <= count; x += 4) {
    const int64_t sx = flip ? source_x - (int64_t)x : source_x + (int64_t)x;
    const __m128i s = load_pixels4(source, sx, flip);
    const __m128i d = _mm_loadu_si128((const __m128i *)(target + x * 4));
    const __m128i result = _mm_or_si128(_mm_adds_epu8(s, d), _mm_set1_epi32((int32_t)0xff000000u));
    _mm_storeu_si128((__m128i *)(target + x * 4), result);
  }
#endif
  for (; x < count; x++) {
    const size_t sx = (size_t)(flip ? source_x - (int64_t)x : source_x + (int64_t)x);
    const uint8_t *s = source + sx * 4;
    uint8_t *t = target + x * 4;
    t[0] = saturated_sum(t[0], s[0]);
    t[1] = saturated_sum(t[1], s[1]);
    t[2] = saturated_sum(t[2], s[2]);
    t[3] = 255;
  }
}

static napi_value premultiply_into(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  bytes source, target;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 2 ||
      !get_bytes(env, argv[0], &source) || !get_bytes(env, argv[1], &target) ||
      source.length != target.length || source.length % 4)
    return fail(env, "Premultiplication requires equal RGBA8 byte arrays");
  const uintptr_t s = (uintptr_t)source.data, t = (uintptr_t)target.data;
  if (s != t && source.length &&
      ((s < t && t - s < source.length) || (t < s && s - t < target.length)))
    return fail(env, "Premultiplication buffers may coincide but cannot overlap partially");
  for (size_t i = 0; i < source.length; i += 4) {
    const uint8_t alpha = source.data[i + 3];
    target.data[i] = rounded_product(source.data[i], alpha);
    target.data[i + 1] = rounded_product(source.data[i + 1], alpha);
    target.data[i + 2] = rounded_product(source.data[i + 2], alpha);
    target.data[i + 3] = alpha;
  }
  return argv[1];
}

static napi_value scale_opacity_into(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  bytes source, target;
  double opacity;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 3 ||
      !get_bytes(env, argv[0], &source) || !get_bytes(env, argv[1], &target) ||
      source.length != target.length || source.length % 4 ||
      napi_get_value_double(env, argv[2], &opacity) != napi_ok ||
      !(opacity >= 0 && opacity <= 255) || (double)(uint8_t)opacity != opacity)
    return fail(env, "Opacity scaling requires equal RGBA8 byte arrays and an integer opacity byte");
  const uintptr_t s = (uintptr_t)source.data, t = (uintptr_t)target.data;
  if (s != t && source.length &&
      ((s < t && t - s < source.length) || (t < s && s - t < target.length)))
    return fail(env, "Opacity buffers may coincide but cannot overlap partially");
  const uint8_t alpha = (uint8_t)opacity;
  size_t i = 0;
#if defined(BLITTER_SSE2)
  const __m128i zero = _mm_setzero_si128();
  const __m128i multiplier = _mm_set1_epi16(alpha);
  const __m128i bias = _mm_set1_epi16(255);
  for (; i + 16 <= source.length; i += 16) {
    const __m128i pixels = _mm_loadu_si128((const __m128i *)(source.data + i));
    const __m128i lo = _mm_srli_epi16(_mm_add_epi16(
      _mm_mullo_epi16(_mm_unpacklo_epi8(pixels, zero), multiplier), bias), 8);
    const __m128i hi = _mm_srli_epi16(_mm_add_epi16(
      _mm_mullo_epi16(_mm_unpackhi_epi8(pixels, zero), multiplier), bias), 8);
    _mm_storeu_si128((__m128i *)(target.data + i), _mm_packus_epi16(lo, hi));
  }
#endif
  // Skia's globalAlpha scale uses ceil(byte * quantizedAlpha / 256), not / 255.
  for (; i < source.length; i++)
    target.data[i] = (uint8_t)(((unsigned)source.data[i] * alpha + 255) >> 8);
  return argv[1];
}

static napi_value clear_opaque(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  bytes target;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1 ||
      !get_bytes(env, argv[0], &target) || target.length % 4)
    return fail(env, "Opaque clear requires an RGBA8 byte array");
  size_t i = 0;
#if defined(BLITTER_SSE2)
  const __m128i black = _mm_set1_epi32((int32_t)0xff000000u);
  for (; i + 16 <= target.length; i += 16)
    _mm_storeu_si128((__m128i *)(target.data + i), black);
#endif
  for (; i < target.length; i += 4) {
    target.data[i] = 0;
    target.data[i + 1] = 0;
    target.data[i + 2] = 0;
    target.data[i + 3] = 255;
  }
  return argv[0];
}

static napi_value compose_batch(napi_env env, napi_callback_info info, bool masked) {
  size_t argc = masked ? 6 : 5;
  napi_value argv[6];
  bytes target, mask = {NULL, 0};
  uint32_t width, height, frame_count;
  bool is_array = false, typed = false, array_buffer = false, detached = false;
  napi_typedarray_type type;
  size_t descriptor_length, offset;
  int32_t *descriptors;
  napi_value buffer;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok ||
      argc != (masked ? 6u : 5u) ||
      !get_bytes(env, argv[0], &target) || !get_u32(env, argv[1], &width) ||
      !get_u32(env, argv[2], &height) ||
      (uint64_t)width * height > SIZE_MAX / 4 ||
      target.length != (size_t)width * height * 4 ||
      napi_is_typedarray(env, argv[3], &typed) != napi_ok || !typed ||
      napi_get_typedarray_info(env, argv[3], &type, &descriptor_length,
                              (void **)&descriptors, &buffer, &offset) != napi_ok ||
      type != napi_int32_array || descriptor_length % DESCRIPTOR_SIZE ||
      descriptor_length / DESCRIPTOR_SIZE > MAX_COMMANDS ||
      napi_is_array(env, argv[4], &is_array) != napi_ok || !is_array ||
      napi_get_array_length(env, argv[4], &frame_count) != napi_ok ||
      frame_count > MAX_FRAMES ||
      (masked && (!get_bytes(env, argv[5], &mask) ||
        (uint64_t)((width + 15u) / 16u) * ((height + 15u) / 16u) > SIZE_MAX ||
        mask.length != (size_t)((width + 15u) / 16u) * ((height + 15u) / 16u))))
    return fail(env, "Invalid integer-blitter target, descriptors, or frame array");

  bytes *frames = frame_count ? calloc(frame_count, sizeof(bytes)) : NULL;
  napi_value *values = frame_count ? calloc(frame_count, sizeof(napi_value)) : NULL;
  if (frame_count && (!frames || !values)) {
    free(frames);
    free(values);
    return fail(env, "Cannot allocate bounded integer-blitter frame table");
  }
  const char *error = NULL;
  uint64_t pixels_skipped = 0, pixels_to_resolved_cells = 0;
  const uint32_t mask_width = (width + 15u) / 16u;
  /* Resolve possible array getters before retaining any raw data pointer. */
  for (uint32_t i = 0; i < frame_count; i++) {
    if (napi_get_element(env, argv[4], i, &values[i]) != napi_ok) {
      error = "Integer-blitter frames must be RGBA8 byte arrays";
      goto finish;
    }
  }
  if (!get_bytes(env, argv[0], &target) ||
      target.length != (size_t)width * height * 4 ||
      napi_get_typedarray_info(env, argv[3], &type, &descriptor_length,
                              (void **)&descriptors, &buffer, &offset) != napi_ok ||
      type != napi_int32_array || descriptor_length % DESCRIPTOR_SIZE ||
      descriptor_length / DESCRIPTOR_SIZE > MAX_COMMANDS ||
      napi_is_arraybuffer(env, buffer, &array_buffer) != napi_ok || !array_buffer ||
      napi_is_detached_arraybuffer(env, buffer, &detached) != napi_ok || detached ||
      (masked && (!get_bytes(env, argv[5], &mask) ||
        mask.length != (size_t)mask_width * ((height + 15u) / 16u)))) {
    error = "Integer-blitter buffers must be attached, nonshared typed arrays";
    goto finish;
  }
  const uintptr_t commands = (uintptr_t)descriptors, destination = (uintptr_t)target.data;
  const size_t command_bytes = descriptor_length * sizeof(int32_t);
  if (command_bytes &&
      ((commands <= destination && destination - commands < command_bytes) ||
       (destination < commands && commands - destination < target.length))) {
    error = "Integer-blitter descriptors must not alias the destination";
    goto finish;
  }
  if (masked) {
    const uintptr_t mask_start = (uintptr_t)mask.data;
    if (mask.length &&
        ((mask_start <= destination && destination - mask_start < mask.length) ||
         (destination < mask_start && mask_start - destination < target.length))) {
      error = "Integer-blitter mask must not alias the destination";
      goto finish;
    }
  }
  for (uint32_t i = 0; i < frame_count; i++) {
    if (!get_bytes(env, values[i], &frames[i])) {
      error = "Integer-blitter frames must be RGBA8 byte arrays";
      goto finish;
    }
    const uintptr_t s = (uintptr_t)frames[i].data, t = (uintptr_t)target.data;
    if (frames[i].length &&
        ((s <= t && t - s < frames[i].length) ||
         (t < s && s - t < target.length))) {
      error = "Integer-blitter sources must not alias the destination";
      goto finish;
    }
  }

  /* Validate the entire batch before writing the destination. */
  for (size_t i = 0; i < descriptor_length; i += DESCRIPTOR_SIZE) {
    const int32_t *d = descriptors + i;
    if (d[0] < 0 || (uint32_t)d[0] >= frame_count || d[1] < 1 || d[2] < 1 ||
        (uint64_t)d[1] * (uint32_t)d[2] > SIZE_MAX / 4 ||
        frames[d[0]].length != (size_t)d[1] * d[2] * 4 ||
        (d[5] != 0 && d[5] != 1) || (d[6] != 0 && d[6] != 1) ||
        (d[7] != 0 && d[7] != 1)) {
      error = "Invalid integer-blitter frame index, dimensions, flips, or blend";
      goto finish;
    }
  }

  for (size_t i = 0; i < descriptor_length; i += DESCRIPTOR_SIZE) {
    const int32_t *d = descriptors + i;
    const int64_t fw = d[1], fh = d[2], dx = d[3], dy = d[4];
    const int64_t x0 = dx < 0 ? 0 : dx, y0 = dy < 0 ? 0 : dy;
    const int64_t x1 = dx + fw > width ? width : dx + fw;
    const int64_t y1 = dy + fh > height ? height : dy + fh;
    if (x1 <= x0 || y1 <= y0) continue;
    const uint8_t *source = frames[d[0]].data;
    const bool flip_x = d[5], flip_y = d[6], additive = d[7];
    if (!masked) {
      const int64_t source_x = flip_x ? fw - 1 - (x0 - dx) : x0 - dx;
      const size_t count = (size_t)(x1 - x0);
      for (int64_t y = y0; y < y1; y++) {
        const int64_t sy = flip_y ? fh - 1 - (y - dy) : y - dy;
        const uint8_t *s = source + (size_t)sy * (size_t)fw * 4;
        uint8_t *t = target.data + ((size_t)y * width + (size_t)x0) * 4;
        if (additive) additive_row(t, s, source_x, count, flip_x);
        else source_over_row(t, s, source_x, count, flip_x);
      }
      continue;
    }
    /* Split inside C at exact destination cell boundaries, not into JS
     * commands. A -8px-offset 32px wall can touch 3x3 mask cells. All rows of
     * this plane finish before the next descriptor, preserving transparency. */
    for (int64_t y = y0; y < y1;) {
      const int64_t cell_y1 = ((y >> 4) + 1) * 16;
      const int64_t end_y = cell_y1 < y1 ? cell_y1 : y1;
      for (int64_t x = x0; x < x1;) {
        const int64_t cell_x1 = ((x >> 4) + 1) * 16;
        const int64_t end_x = cell_x1 < x1 ? cell_x1 : x1;
        const uint8_t cell = mask.data[(size_t)(y >> 4) * mask_width + (size_t)(x >> 4)];
        if (cell) {
          const uint64_t skipped = (uint64_t)(end_x - x) * (uint64_t)(end_y - y);
          pixels_skipped += skipped;
          if (cell == 1) pixels_to_resolved_cells += skipped;
        } else {
          const int64_t source_x = flip_x ? fw - 1 - (x - dx) : x - dx;
          const size_t count = (size_t)(end_x - x);
          for (int64_t row = y; row < end_y; row++) {
            const int64_t sy = flip_y ? fh - 1 - (row - dy) : row - dy;
            const uint8_t *s = source + (size_t)sy * (size_t)fw * 4;
            uint8_t *t = target.data + ((size_t)row * width + (size_t)x) * 4;
            if (additive) additive_row(t, s, source_x, count, flip_x);
            else source_over_row(t, s, source_x, count, flip_x);
          }
        }
        x = end_x;
      }
      y = end_y;
    }
  }

finish:
  free(frames);
  free(values);
  if (error) return fail(env, error);
  if (masked) {
    napi_value result, skipped, resolved;
    if (napi_create_object(env, &result) != napi_ok ||
        napi_create_double(env, (double)pixels_skipped, &skipped) != napi_ok ||
        napi_create_double(env, (double)pixels_to_resolved_cells, &resolved) != napi_ok ||
        napi_set_named_property(env, result, "pixelsSkipped", skipped) != napi_ok ||
        napi_set_named_property(env, result, "pixelsToResolvedCells", resolved) != napi_ok)
      return NULL;
    return result;
  }
  return argv[0];
}

static napi_value compose_into(napi_env env, napi_callback_info info) {
  return compose_batch(env, info, false);
}

static napi_value compose_into_masked(napi_env env, napi_callback_info info) {
  return compose_batch(env, info, true);
}

static napi_value init(napi_env env, napi_value exports) {
  const napi_property_descriptor properties[] = {
    {"composeInto", NULL, compose_into, NULL, NULL, NULL, napi_default, NULL},
    {"composeIntoMasked", NULL, compose_into_masked, NULL, NULL, NULL, napi_default, NULL},
    {"premultiplyInto", NULL, premultiply_into, NULL, NULL, NULL, napi_default, NULL},
    {"scaleOpacityInto", NULL, scale_opacity_into, NULL, NULL, NULL, napi_default, NULL},
    {"clearOpaque", NULL, clear_opaque, NULL, NULL, NULL, napi_default, NULL},
  };
  if (napi_define_properties(env, exports, 5, properties) != napi_ok) return NULL;
  napi_value kernel;
#if defined(BLITTER_SSE2)
  const char *kernel_name = "sse2";
#else
  const char *kernel_name = "scalar";
#endif
  if (napi_create_string_utf8(env, kernel_name, NAPI_AUTO_LENGTH, &kernel) != napi_ok ||
      napi_set_named_property(env, exports, "kernel", kernel) != napi_ok) return NULL;
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
