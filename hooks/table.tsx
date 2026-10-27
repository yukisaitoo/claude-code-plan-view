import type { ElementTable } from 'claude-code'

import { startsBlock } from './markdown'
import type { Table } from './markdown'

/** Spaces between two columns. */
const COLUMN_GAP = 2
/**
 * A column is never narrower than its longest word, up to this cap, so a long
 * path or URL wraps instead of turning the whole table into a list.
 */
const MAX_MIN_WIDTH = 20
/**
 * Emoji, flags and East Asian characters take two cells on screen: Han, kana
 * (with ー and ・), Hangul, CJK punctuation like 「」、。 and fullwidth forms.
 */
const WIDE_CHAR =
  /[\p{Emoji_Presentation}\p{Regional_Indicator}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303F\u30A0-\u30FF\u3200-\u33FF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/u
/** A symbol that the emoji variation selector draws as a two-cell emoji, like ❤️. */
const EMOJI_BY_SELECTOR = /\p{Extended_Pictographic}\uFE0F/u
/** What a reader sees as one character, like 👍🏽 or 🇯🇵, though it's several code points. */
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
/** A bullet alone, which a Markdown block of its own draws as an empty list item. */
const BARE_BULLET = /^[-+*]$/
/** A numbered item's "1." or "1)", escaped as "1\." to stay inline. */
const NUMBERED_START = /^(\d{1,9})([.)])(?=\s|$)/

/**
 * Draws a table that fits in `width`. Claude Code sizes Markdown tables for
 * the full-width chat, so in the pane they fall apart. Draws a grid when the
 * columns fit without breaking words, and a list otherwise, as the chat does.
 */
export function drawTable(elements: ElementTable, table: Table, width: number, key: string) {
  // Pad short rows and cut long ones, as GFM does, so every row has a cell under each heading.
  const columnCount = table.header.length
  const padRow = (row: string[]) => Array.from({ length: columnCount }, (_, i) => row[i] ?? '')
  const padded = { header: padRow(table.header), rows: table.rows.map(padRow) }

  const column = (i: number) => [padded.header, ...padded.rows].map(row => row[i]!)
  const contentWidths = padded.header.map((_, i) => Math.max(1, ...column(i).map(displayWidth)))
  const minWidths = padded.header.map((_, i) => Math.min(MAX_MIN_WIDTH, Math.max(1, ...column(i).map(longestWord))))
  const widths = fitColumns(contentWidths, minWidths, width - COLUMN_GAP * (columnCount - 1))

  return widths ? drawGrid(elements, padded, widths, key) : drawList(elements, padded, width, key)
}

/**
 * Draws each row as "**Header:** value" lines, with a rule between rows. A
 * table with no rows yet shows its headings, one per line.
 */
function drawList({ Box, Markdown, Text }: ElementTable, { header, rows }: Table, width: number, key: string) {
  const label = (i: number) => (header[i] ? `**${escapeTrailingBackslash(header[i])}:** ` : '')
  return (
    <Box key={key} flexDirection="column" marginY={1}>
      {rows.length === 0 && <Markdown text={header.filter(Boolean).map(bold).join('\n')} />}
      {rows.map((row, r) => (
        <Box key={`row-${r}`} flexDirection="column">
          {r > 0 && <Text dimColor>{'─'.repeat(width)}</Text>}
          <Markdown text={row.map((cell, i) => label(i) + inline(cell)).join('\n')} />
        </Box>
      ))}
    </Box>
  )
}

/** Draws the header, a rule, then the rows, each cell wrapping inside its column. */
function drawGrid({ Box, Markdown, Text }: ElementTable, { header, rows }: Table, widths: number[], key: string) {
  const rule = '─'.repeat(sum(widths) + COLUMN_GAP * (widths.length - 1))
  const drawCells = (row: string[], isHeader: boolean) =>
    row.map((cell, i) => (
      <Box key={`cell-${i}`} width={widths[i]} flexShrink={0}>
        {cell && <Markdown text={isHeader ? bold(cell) : inline(cell)} />}
      </Box>
    ))

  return (
    <Box key={key} flexDirection="column" marginY={1}>
      <Box flexDirection="row" columnGap={COLUMN_GAP}>
        {drawCells(header, true)}
      </Box>
      <Text>{rule}</Text>
      {rows.map((row, r) => (
        <Box key={`row-${r}`} flexDirection="column">
          {r > 0 && <Text dimColor>{rule}</Text>}
          <Box flexDirection="row" columnGap={COLUMN_GAP}>
            {drawCells(row, false)}
          </Box>
        </Box>
      ))}
    </Box>
  )
}

/**
 * Picks each column's width so the table fits in `available` cells, or
 * returns undefined when even the minimums don't fit. The cells left after
 * the minimums are shared by the square root of each column's content
 * width, so a long column gets more room without starving a short one.
 */
function fitColumns(contentWidths: number[], minWidths: number[], available: number): number[] | undefined {
  if (sum(minWidths) > available) return undefined
  if (sum(contentWidths) <= available) return contentWidths

  const widths = [...minWidths]
  let spare = available - sum(widths)
  const room = (i: number) => contentWidths[i]! - widths[i]!
  const weight = (i: number) => Math.sqrt(contentWidths[i]!)
  const indexes = widths.map((_, i) => i)

  // A column that reaches its content width stops growing, which frees its
  // share for the others, so repeat until the shares round down to nothing.
  let given: number
  do {
    const growing = indexes.filter(i => room(i) > 0)
    const totalWeight = sum(growing.map(weight))
    given = 0
    for (const i of growing) {
      const cells = Math.min(room(i), Math.floor((spare * weight(i)) / totalWeight))
      widths[i] = widths[i]! + cells
      given += cells
    }
    spare -= given
  } while (given > 0)

  // Rounding leaves fewer cells than there are growing columns: one each,
  // widest column first.
  const widestFirst = indexes.toSorted((a, b) => contentWidths[b]! - contentWidths[a]!)
  for (const i of widestFirst) {
    if (spare === 0) break
    if (room(i) > 0) {
      widths[i] = widths[i]! + 1
      spare--
    }
  }
  return widths
}

/** Roughly how many cells a cell's text takes on screen. */
function displayWidth(text: string) {
  return cellsWide(shownText(text))
}

/** How many cells `shown` takes on screen. */
function cellsWide(shown: string) {
  let width = 0
  for (const { segment } of graphemes.segment(shown)) {
    width += WIDE_CHAR.test(segment) || EMOJI_BY_SELECTOR.test(segment) ? 2 : 1
  }
  return width
}

/**
 * Roughly the text Markdown draws for a cell: a code span's contents as they
 * are, and outside code, a link's text, without `**` or `__`, and an escaped
 * character without its backslash.
 */
function shownText(text: string): string {
  let shown = ''
  let i = 0
  while (i < text.length) {
    const rest = text.slice(i)
    const run = /^`+/.exec(rest)?.[0]
    if (run) {
      // A code span closes on a backtick run of the same length, as in splitRow.
      const close = new RegExp(`(?<!\`)${run}(?!\`)`).exec(rest.slice(run.length))
      if (!close) {
        shown += run
        i += run.length
        continue
      }
      const code = rest.slice(run.length, run.length + close.index)
      // Markdown drops one space from each end when both have one, unless it's all spaces.
      shown += /^ .*[^ ].* $/s.test(code) ? code.slice(1, -1) : code
      i += run.length * 2 + close.index
      continue
    }

    const link = /^\[([^\]]*)\]\([^)]*\)/.exec(rest)
    if (link) {
      shown += shownText(link[1]!)
      i += link[0].length
    } else if (rest.startsWith('**') || rest.startsWith('__')) {
      i += 2
    } else if (rest[0] === '\\' && /^[!-/:-@[-`{-~]/.test(rest[1] ?? '')) {
      shown += rest[1]
      i += 2
    } else {
      shown += rest[0]
      i++
    }
  }
  return shown
}

/** A cell's text in bold. */
function bold(text: string) {
  return `**${escapeTrailingBackslash(text)}**`
}

/** Doubles an unpaired trailing backslash, which would otherwise escape the `**` or `:` after it. */
function escapeTrailingBackslash(text: string) {
  const backslashes = /\\*$/.exec(text)![0].length
  return backslashes % 2 ? text + '\\' : text
}

/**
 * A body cell escaped so Markdown reads it as inline text, the way a table
 * cell is, not as a block like a quote, heading, list item, fence or rule.
 */
function inline(cell: string) {
  if (NUMBERED_START.test(cell)) return cell.replace(NUMBERED_START, '$1\\$2')
  return cell && (startsBlock(cell) || BARE_BULLET.test(cell)) ? '\\' + cell : cell
}

function longestWord(text: string) {
  return Math.max(0, ...shownText(text).split(/\s+/).map(cellsWide))
}

function sum(numbers: number[]) {
  return numbers.reduce((total, n) => total + n, 0)
}
