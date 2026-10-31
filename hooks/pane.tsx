import type { ElementTable, RenderSurface } from 'claude-code'

import type { Plan } from '../types'
import type { Block } from './markdown'
import { normalize, splitTables, unwrap } from './markdown'
import { drawTable } from './table'

export const NO_PLAN = 'No plan yet in this session.'

/** A skin tone modifier. */
const SKIN_TONE = /[\u{1F3FB}-\u{1F3FF}]/gu

/** The tag characters that turn a black flag into a flag like Scotland's. */
const FLAG_TAGS = /[\u{E0020}-\u{E007F}]/gu

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** The plan file's text, cleaned up and ready to draw. */
export function planTextToDraw(text: string) {
  return unwrap(simplifyEmoji(normalize(text)))
}

/**
 * Some terminals, draw a joined emoji wider than the 2 cells CC lays it
 * out in.
 *
 * So the pane draws the simple emoji instead: a joined one's first part only.
 */
function simplifyEmoji(text: string) {
  let simple = ''
  for (const { segment } of graphemes.segment(text)) {
    const joiner = segment.indexOf('\u200D')
    const isJoinedEmoji = joiner > 0 && /\p{Extended_Pictographic}/u.test(segment)
    simple += isJoinedEmoji ? segment.slice(0, joiner) : segment
  }
  return simple.replace(SKIN_TONE, '').replace(FLAG_TAGS, '')
}

/** The pane's contents: the plan's full path, so it can be selected and copied, then the plan itself. */
export function drawPlan(
  elements: ElementTable,
  current: Plan | null,
  text: string | null,
  surface: RenderSurface,
  width: number,
) {
  const { Box, Markdown, Text } = elements
  if (!current) return <Text dimColor>{NO_PLAN}</Text>
  if (text === null) return <Text dimColor>Can't read the plan file: {current.path}</Text>

  // Other surfaces draw Markdown as a full page, where tables fit fine.
  const blocks: Block[] = surface === 'terminal' ? splitTables(text) : [{ kind: 'markdown', text }]

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text dimColor>{current.path}</Text>
      </Box>
      {blocks.map((block, i) => {
        const key = `block-${i}`
        if (block.kind === 'table') return drawTable(elements, block.table, width, key)
        return block.text.trim() ? <Markdown key={key} text={block.text} /> : null
      })}
    </Box>
  )
}
