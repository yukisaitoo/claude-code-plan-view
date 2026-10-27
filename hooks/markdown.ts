// How each kind of Markdown block starts. Most allow the up to 3 spaces of
// indent CommonMark does, and `startsBlock` also checks them at any indent,
// for nested lists. Two exceptions: the fences match at any indent, so a code
// block in a nested list is found, and the HTML tags match at none, as their
// callers trim the line first.
/**
 * "```" or "~~~" opening a code block, maybe followed by a language. A
 * backtick fence's language can't hold a backtick, so "```code``` text" is
 * inline code, not a fence.
 */
const FENCE = /^[ \t]*(?:(`{3,})[^`]*|(~{3,}).*)$/
/** "```" or "~~~" alone on its line, closing a code block. */
const CLOSING_FENCE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/
/** The "> " of a quote. */
const QUOTE = /^ {0,3}>[ \t]?/
/** Every quote marker opening a line, like the "> > " of a nested quote. */
const QUOTES = /^(?: {0,3}>[ \t]?)*/
/** "# Title" through "###### Title". */
const HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/
/** A thematic break (---, ***, ___, all one character), or the === / --- underline of a heading. */
const RULE = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|=+[ \t]*|-+[ \t]*)$/
/** "- item", "* item", "+ item", "1. item" or "1) item". */
const LIST_ITEM = /^ {0,3}(?:[-*+][ \t]|\d{1,9}[.)](?:[ \t]|$))/
/** A numbered item, like "2. item", or a year that only looks like one. */
const NUMBERED_ITEM = /^\d{1,9}[.)](?:[ \t]|$)/
/** "1. item" or "1) item", the only numbered item that can start a list in the middle of a paragraph. */
const FIRST_ITEM = /^1[.)][ \t]+\S/
/** Four spaces or a tab, which after a blank line starts indented code. */
const INDENTED_CODE = /^(?: {4}|\t)/
/** The |---|:---:| row under a table's header. */
const DELIMITER_ROW = /^ {0,3}(?:\|[ \t]*)?:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/
/**
 * A block-level HTML tag opening a line, like <details> or </div>, which
 * starts an HTML block even in the middle of a paragraph. The names are
 * CommonMark's. The name must end at a space, `/`, `>` or the line's end.
 */
const HTML_BLOCK_TAG = new RegExp(
  '^</?(?:' +
    'pre|script|style|textarea|address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|' +
    'dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|' +
    'hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|' +
    'summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul' +
    ')(?:[\\s/>]|$)',
  'i',
)
/**
 * Any other tag alone on its line, like <PlanPane>, which starts an HTML block
 * only where a paragraph isn't going on. Inside one it's just inline text.
 */
const LONE_TAG = /^<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^>]*)?\/?>\s*$/
/** Two trailing spaces or a trailing backslash. */
const HARD_BREAK = /(?: {2}|\\)$/

export type Table = { header: string[]; rows: string[][] }
export type Block = { kind: 'markdown'; text: string } | { kind: 'table'; table: Table }

/**
 * Cleans text read from a file: drops a byte order mark, turns Windows \r\n
 * line endings into \n, and removes the control characters Markdown text
 * may not hold (all but tab and newline).
 */
export function normalize(text: string) {
  return text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, '')
}

/**
 * Joins hard-wrapped lines back together, as a Markdown renderer would.
 * Claude Code draws every newline as a line break, so a plan wrapped at 80
 * columns looks ragged in a narrower pane. A line joins the one before it
 * unless it starts a new block; code, tables, headings and hard breaks keep
 * their line breaks.
 */
export function unwrap(text: string) {
  const source = text.split('\n')
  const lines: string[] = []
  const isCodeLine = codeTracker()
  // Inside an HTML block, which lasts until a blank line, or a table, which
  // ends where splitTables ends it.
  let verbatim: 'block' | 'table' | undefined
  // The line the current table's header is on.
  let tableStart = 0
  // Whether the next line may be joined onto the last one.
  let canContinue = false
  // Whether the block since the last blank line has list items, where any
  // numbered item starts a new item.
  let isInList = false

  // Each line without its quote marker, so a quoted table is found too.
  const contents = source.map(line => line.replace(QUOTE, ''))

  for (const [i, line] of source.entries()) {
    const isQuoted = QUOTE.test(line)
    const content = contents[i]!

    if (isCodeLine(line)) {
      lines.push(line)
      verbatim = undefined
      canContinue = false
      continue
    }

    const previous = lines.at(-1) ?? ''
    // The delimiter row, right under the header, never ends the table.
    if (verbatim === 'table' && i > tableStart + 1 && endsTable(content)) verbatim = undefined
    if (!content.trim()) verbatim = undefined
    else if (startsTable(contents, i)) {
      verbatim = 'table'
      tableStart = i
    } else if (HTML_BLOCK_TAG.test(content.trimStart())) verbatim = 'block'
    else if (!canContinue && LONE_TAG.test(content.trimStart())) verbatim = 'block'

    // A quoted line only continues a quoted line. An unquoted line can
    // continue either, which Markdown calls "lazy continuation".
    const quoteAllowsJoin = !isQuoted || QUOTE.test(previous)
    // Outside a list, a line like "2026. After that" carries on the paragraph.
    const unindented = content.trimStart()
    const isNumberInProse = !isInList && NUMBERED_ITEM.test(unindented) && !FIRST_ITEM.test(unindented)
    if (canContinue && !verbatim && quoteAllowsJoin && (isNumberInProse || !startsBlock(content))) {
      lines[lines.length - 1] += ' ' + unindented
    } else {
      lines.push(line)
      if (LIST_ITEM.test(unindented)) isInList = true
    }
    if (!content.trim()) isInList = false

    const last = lines.at(-1)!
    const lastContent = last.replace(QUOTE, '')
    canContinue =
      !verbatim &&
      lastContent.trim() !== '' &&
      !HEADING.test(lastContent) &&
      !RULE.test(lastContent) &&
      !HARD_BREAK.test(last)
  }
  return lines.join('\n')
}

/**
 * Splits the plan into Markdown and tables, so the pane can draw tables
 * itself. A table is a header row, a delimiter row with as many cells, then
 * every row down to a line that `endsTable`. A table inside a quote is left
 * to Claude Code's Markdown on purpose: drawing it here would lose the
 * quote's bar.
 */
export function splitTables(text: string): Block[] {
  const source = text.split('\n')
  const blocks: Block[] = []
  let markdown: string[] = []
  const isCodeLine = codeTracker()

  const flushMarkdown = () => {
    if (markdown.some(line => line.trim())) blocks.push({ kind: 'markdown', text: markdown.join('\n') })
    markdown = []
  }

  let i = 0
  while (i < source.length) {
    const line = source[i]!
    if (isCodeLine(line) || !startsTable(source, i)) {
      markdown.push(line)
      i++
      continue
    }

    const header = splitRow(line)
    const rows: string[][] = []
    // Skip the header and delimiter rows.
    i += 2
    while (i < source.length && !endsTable(source[i]!)) {
      rows.push(splitRow(source[i]!))
      i++
    }
    flushMarkdown()
    blocks.push({ kind: 'table', table: { header, rows } })
  }
  flushMarkdown()
  return blocks
}

/** Whether `line` is blank or starts a block, at any indent. */
export function startsBlock(line: string) {
  const unindented = line.trimStart()
  return (
    !unindented || [LIST_ITEM, QUOTE, HEADING, RULE, FENCE, HTML_BLOCK_TAG].some(pattern => pattern.test(unindented))
  )
}

/**
 * Whether a line after a table's delimiter row ends the table: a blank line,
 * one without a `|`, or one that starts another block, like a fence or a
 * list item, as in Claude Code's Markdown.
 */
function endsTable(line: string) {
  return !line.includes('|') || startsBlock(line)
}

/** A table starts at a row with a `|` that has a delimiter row with as many cells under it. */
function startsTable(lines: string[], i: number) {
  const line = lines[i]!
  const next = lines[i + 1] ?? ''
  return (
    line.includes('|') &&
    next.includes('|') &&
    DELIMITER_ROW.test(next) &&
    splitRow(line).length === splitRow(next).length
  )
}

/**
 * Returns a function to call on each line in order, which says whether that
 * line is code: inside a code block, or one of its fence lines.
 *
 * A fenced block closes on a bare fence of the same character, at least as
 * long as the opening, in the same quote; a fence with a language after it,
 * like ```bash, is just code. A block opened in a quote also ends with the
 * quote. Indented code starts after a blank line (or at the top) and ends at
 * the first line that isn't blank or indented.
 */
function codeTracker() {
  // The fence that opened the current code block, or undefined outside one.
  let openFence: string | undefined
  // How many quotes deep that fence is.
  let fenceDepth = 0
  let isInIndentedCode = false
  // Whether the last line was blank, or there wasn't one: where indented code can start.
  let isAfterBlank = true

  return (line: string) => {
    const markers = QUOTES.exec(line)![0]
    const depth = markers.split('>').length - 1
    const content = line.slice(markers.length)
    if (depth < fenceDepth) openFence = undefined

    let isCode = true
    if (openFence !== undefined) {
      const marker = depth === fenceDepth ? CLOSING_FENCE.exec(content)?.[1] : undefined
      if (marker && marker[0] === openFence[0] && marker.length >= openFence.length) openFence = undefined
    } else if (content.trim() && INDENTED_CODE.test(content) && (isInIndentedCode || isAfterBlank)) {
      isInIndentedCode = true
    } else {
      isInIndentedCode = false
      const opening = FENCE.exec(content)
      if (opening) {
        openFence = opening[1] ?? opening[2]
        fenceDepth = depth
      }
      isCode = opening !== null
    }
    isAfterBlank = !content.trim()
    return isCode
  }
}

/** Splits a table row into cells on each `|`, except inside a code span or when escaped as `\|`. */
function splitRow(row: string) {
  let line = row.trim()
  if (line.startsWith('|')) line = line.slice(1)
  if (line.endsWith('|') && !line.endsWith('\\|')) line = line.slice(0, -1)

  const cells: string[] = []
  let cell = ''
  // The length of the backtick run that opened the current code span, or 0.
  let openBackticks = 0
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!
    if (char === '\\' && line[i + 1] === '|') {
      cell += '|'
      i++
    } else if (char === '`') {
      const run = /^`+/.exec(line.slice(i))![0]
      // A code span closes on a backtick run of the same length, so a run
      // with no such partner later in the row is just backticks.
      const hasPartner = new RegExp(`(?<!\`)${run}(?!\`)`).test(line.slice(i + run.length))
      if (!openBackticks) openBackticks = hasPartner ? run.length : 0
      else if (openBackticks === run.length) openBackticks = 0
      cell += run
      i += run.length - 1
    } else if (char === '|' && !openBackticks) {
      cells.push(cell.trim())
      cell = ''
    } else {
      cell += char
    }
  }
  cells.push(cell.trim())
  return cells
}
