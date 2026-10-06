import { getHeapStatistics } from "node:v8";

const nativeMemoryUsage = process.memoryUsage.bind(process);
const nativeResourceUsage = process.resourceUsage.bind(process);
const unavailableCodes = new Set([
  "ENOENT",
  "ESRCH",
  "EACCES",
  "EPERM",
  "ENOSYS",
  "ENOTSUP",
]);

function checkedBytes(value, label, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || value < 0 || (positive && value === 0))
    throw new Error(
      `Unavailable or invalid ${label}; memory cannot be measured`,
    );
  return value;
}

/**
 * Some restricted Linux environments cannot expose /proc to libuv, so
 * process.memoryUsage() throws even though getrusage and V8 statistics work.
 * In that case rss is a conservative OS lifetime peak, explicitly NOT a
 * current-RSS sample. Never infer native/ArrayBuffer bytes from heap totals.
 * Dependency injection keeps this failure path testable without a sandbox.
 */
export function createProcessMemorySampler({
  memoryUsage = nativeMemoryUsage,
  resourceUsage = nativeResourceUsage,
  heapStatistics = getHeapStatistics,
} = {}) {
  const counters = {
    samples: 0,
    currentRssSamples: 0,
    lifetimePeakFallbackSamples: 0,
    currentRssAvailable: null,
    arrayBuffersAvailable: null,
    fallbackReasons: {},
    lastFallbackError: null,
  };

  function sample() {
    let current;
    try {
      current = memoryUsage();
    } catch (error) {
      if (!unavailableCodes.has(error?.code)) throw error;
      const usage = resourceUsage();
      const rss = checkedBytes(usage.maxRSS * 1024, "OS lifetime peak RSS", {
        positive: true,
      });
      const heap = heapStatistics();
      const result = {
        rss,
        heapTotal: checkedBytes(heap.total_heap_size, "V8 heap total"),
        heapUsed: checkedBytes(heap.used_heap_size, "V8 heap used"),
        external: checkedBytes(heap.external_memory, "V8 external memory"),
        arrayBuffers: null,
        rssCurrentAvailable: false,
        rssCurrentBytes: null,
        rssSource: "resourceUsage.maxRSS-lifetime-peak",
        osPeakRssBytes: rss,
        arrayBuffersAvailable: false,
        memorySamplingError: { code: error.code, message: error.message },
      };
      counters.samples++;
      counters.lifetimePeakFallbackSamples++;
      counters.currentRssAvailable = false;
      counters.arrayBuffersAvailable = false;
      counters.fallbackReasons[error.code] =
        (counters.fallbackReasons[error.code] || 0) + 1;
      counters.lastFallbackError = result.memorySamplingError;
      return result;
    }
    // A preloaded sampler can already have supplied explicit fallback metadata.
    // Preserve it instead of relabeling a lifetime peak as contemporaneous RSS.
    checkedBytes(current.rss, "process RSS", { positive: true });
    const isCurrent = current.rssCurrentAvailable !== false;
    const arrayBuffersAvailable =
      current.arrayBuffersAvailable !== false &&
      Number.isSafeInteger(current.arrayBuffers) &&
      current.arrayBuffers >= 0;
    counters.samples++;
    counters.currentRssSamples += Number(isCurrent);
    counters.lifetimePeakFallbackSamples += Number(!isCurrent);
    counters.currentRssAvailable = isCurrent;
    counters.arrayBuffersAvailable = arrayBuffersAvailable;
    if (!isCurrent && current.memorySamplingError) {
      const { code } = current.memorySamplingError;
      counters.fallbackReasons[code] =
        (counters.fallbackReasons[code] || 0) + 1;
      counters.lastFallbackError = current.memorySamplingError;
    }
    return {
      ...current,
      arrayBuffers: arrayBuffersAvailable ? current.arrayBuffers : null,
      rssCurrentAvailable: isCurrent,
      rssCurrentBytes: isCurrent ? current.rss : null,
      rssSource: current.rssSource ?? "process.memoryUsage-current-rss",
      arrayBuffersAvailable,
    };
  }

  return {
    sample,
    status() {
      return {
        ...counters,
        fallbackReasons: { ...counters.fallbackReasons },
        lastFallbackError: counters.lastFallbackError
          ? { ...counters.lastFallbackError }
          : null,
        fallbackSemantics:
          "rss is the OS lifetime peak from resourceUsage().maxRSS in bytes; current RSS and ArrayBuffer bytes are unavailable. V8 supplies heap/external statistics. Lifetime wait4 acceptance limits remain unchanged.",
      };
    },
  };
}

const sampler = createProcessMemorySampler();
let installed = false;

export function sampleProcessMemory() {
  return sampler.sample();
}

export function getProcessMemorySamplingStatus() {
  return {
    ...sampler.status(),
    processMemoryUsageOverrideInstalled: installed,
  };
}

/** Explicit opt-in for instrumenting an unchanged benchmark checkout. */
export function installProcessMemoryFallback() {
  if (installed) return;
  const replacement = function memoryUsage() {
    return sampleProcessMemory();
  };
  replacement.rss = function rss() {
    return sampleProcessMemory().rss;
  };
  process.memoryUsage = replacement;
  installed = true;
}
