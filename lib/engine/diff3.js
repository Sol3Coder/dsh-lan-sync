/**
 * Line-based three-way merge (diff3) and a small line diff.
 *
 * Both sides are compared against a common base. Non-overlapping changes are
 * interleaved; overlapping changes become a conflict segment unless both sides
 * made the identical edit. Text is normalised to LF for comparison.
 */

/**
 * @typedef {{ start: number, end: number, lines: string[] }} Chunk
 * `start`/`end` are base line indexes; `lines` replaces `base[start..end)`.
 */

/**
 * Diff two line arrays into changed base ranges.
 * @param {string[]} base
 * @param {string[]} other
 * @returns {Chunk[]}
 */
export function diffLines(base, other) {
  const n = base.length
  const m = other.length
  if (n === 0 && m === 0) return []
  if (n * m > 4_000_000) return [{ start: 0, end: n, lines: other.slice() }]

  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = base[i] === other[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  /** @type {Chunk[]} */
  const chunks = []
  /** @type {Chunk|null} */
  let current = null
  let i = 0
  let j = 0

  const open = (start) => {
    if (!current) current = { start, end: start, lines: [] }
    return current
  }
  const close = () => {
    if (current) chunks.push(current)
    current = null
  }

  while (i < n && j < m) {
    if (base[i] === other[j]) {
      close()
      i += 1
      j += 1
      continue
    }
    if (dp[i + 1][j] >= dp[i][j + 1]) {
      open(i).end = i + 1
      i += 1
    } else {
      open(i).lines.push(other[j])
      j += 1
    }
  }
  while (i < n) {
    open(i).end = i + 1
    i += 1
  }
  while (j < m) {
    open(i).lines.push(other[j])
    j += 1
  }
  close()
  return chunks
}

/** @param {string} text */
function splitLines(text) {
  const normalized = text.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * Replacement lines for base[start..end) given one side's chunks.
 * @param {string[]} base
 * @param {Chunk[]} chunks
 * @param {number} start
 * @param {number} end
 */
function regionReplacement(base, chunks, start, end) {
  /** @type {string[]} */
  const out = []
  let cursor = start
  for (const chunk of chunks) {
    const insertion = chunk.start === chunk.end
    const inside = insertion
      ? (chunk.start >= start && chunk.start < end) || (start === end && chunk.start === start)
      : chunk.start < end && chunk.end > start
    if (!inside) continue
    while (cursor < chunk.start && cursor < end) {
      out.push(base[cursor])
      cursor += 1
    }
    out.push(...chunk.lines)
    cursor = Math.max(cursor, chunk.end)
  }
  while (cursor < end) {
    out.push(base[cursor])
    cursor += 1
  }
  return out
}

/**
 * Three-way merge of text.
 * @param {string|null|undefined} baseText
 * @param {string} oursText
 * @param {string} theirsText
 * @returns {{ clean: boolean, text: string, segments: Array<Record<string, unknown>> }}
 */
export function mergeText(baseText, oursText, theirsText) {
  const trailing = [baseText, oursText, theirsText].some((text) => typeof text === 'string' && text.endsWith('\n'))

  if (baseText == null) {
    const ours = splitLines(oursText ?? '')
    const theirs = splitLines(theirsText ?? '')
    if (ours.join('\n') === theirs.join('\n')) {
      return { clean: true, text: ours.join('\n') + (trailing ? '\n' : ''), segments: [] }
    }
    /** @type {Array<Record<string, unknown>>} */
    const segments = [{ type: 'conflict', ours, theirs }]
    return { clean: false, text: render(segments, trailing), segments }
  }

  const base = splitLines(baseText)
  const ours = splitLines(oursText ?? '')
  const theirs = splitLines(theirsText ?? '')
  const oursChanges = diffLines(base, ours)
  const theirsChanges = diffLines(base, theirs)

  /** @type {Array<Record<string, unknown>>} */
  const segments = []
  let i = 0
  let io = 0
  let it = 0

  while (true) {
    const nextOurs = oursChanges[io]
    const nextTheirs = theirsChanges[it]
    const oursStart = nextOurs ? nextOurs.start : Number.POSITIVE_INFINITY
    const theirsStart = nextTheirs ? nextTheirs.start : Number.POSITIVE_INFINITY

    if (!nextOurs && !nextTheirs) {
      if (i < base.length) segments.push({ type: 'same', lines: base.slice(i) })
      break
    }

    if (oursStart === i && theirsStart === i) {
      let end = Math.max(nextOurs.end, nextTheirs.end)
      // Absorb any further chunk that begins inside the region.
      for (;;) {
        let extended = false
        for (const chunk of oursChanges.slice(io)) {
          if (chunk.start < end && chunk.end > end) {
            end = chunk.end
            extended = true
          }
        }
        for (const chunk of theirsChanges.slice(it)) {
          if (chunk.start < end && chunk.end > end) {
            end = chunk.end
            extended = true
          }
        }
        if (!extended) break
      }
      const oursRegion = regionReplacement(base, oursChanges, i, end)
      const theirsRegion = regionReplacement(base, theirsChanges, i, end)
      if (end === i) {
        // Both sides inserted at this exact point; nothing spans the base.
        io += 1
        it += 1
      } else {
        while (oursChanges[io] && oursChanges[io].start < end) io += 1
        while (theirsChanges[it] && theirsChanges[it].start < end) it += 1
      }
      if (oursRegion.join('\n') === theirsRegion.join('\n')) {
        segments.push({ type: 'same', lines: oursRegion })
      } else {
        segments.push({ type: 'conflict', ours: oursRegion, theirs: theirsRegion })
      }
      i = end
      continue
    }

    if (oursStart === i) {
      segments.push({ type: 'changed', lines: nextOurs.lines })
      i = nextOurs.end
      io += 1
      continue
    }

    if (theirsStart === i) {
      segments.push({ type: 'changed', lines: nextTheirs.lines })
      i = nextTheirs.end
      it += 1
      continue
    }

    segments.push({ type: 'same', lines: [base[i]] })
    i += 1
  }

  const text = render(segments, trailing)
  const clean = !segments.some((segment) => segment.type === 'conflict')
  return { clean, text, segments }
}

/**
 * @param {Array<Record<string, unknown>>} segments
 * @param {boolean} trailing
 */
function render(segments, trailing) {
  /** @type {string[]} */
  const lines = []
  for (const segment of segments) {
    if (segment.type === 'conflict') {
      lines.push('<<<<<<< ours')
      lines.push(.../** @type {string[]} */ (segment.ours))
      lines.push('=======')
      lines.push(.../** @type {string[]} */ (segment.theirs))
      lines.push('>>>>>>> theirs')
    } else {
      lines.push(.../** @type {string[]} */ (segment.lines))
    }
  }
  return lines.join('\n') + (trailing ? '\n' : '')
}
