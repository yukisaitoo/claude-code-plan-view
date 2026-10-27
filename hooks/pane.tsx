import type { ElementTable, EngineInterface, RenderSurface } from 'claude-code'

import type { Plan } from '../types'
import { normalize, splitTables, unwrap } from './markdown'
import type { Block } from './markdown'
import { drawTable } from './table'

export const NO_PLAN = 'No plan yet in this session.'

/** The plan file's text, ready to draw, or null if it can't be read. */
export async function readPlanText($: EngineInterface, path: string) {
  const text = await $.fs.read(path).catch(() => null)
  return text === null ? null : unwrap(normalize(text))
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
