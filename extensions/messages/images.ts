import { Type } from '@earendil-works/pi-ai'
import type { ImageContent, TextContent } from '@earendil-works/pi-ai'
import type { ConversationId, EntryId, EntryRecord, Tx } from '@earendil-works/pi-durable'
import { imagesOf } from '../../lib/entries.ts'
import { imageMimeTypes, maxImageBytes, maxImages } from '../../shared/protocol.ts'

/**
 * Which images to forward: `latest`, the newest entry in the sender's conversation with images (a pasted input or a
 * tool result such as a screenshot), or that entry's id.
 */
export type ImagesRef = 'latest' | number
export const SCAN_PAGE = 200
/** Resolve `ref` against conversation `from`'s visible history to the entry holding the images, checking the limits. */
export async function resolveImages(tx: Tx, from: ConversationId, ref: ImagesRef) {
  let entry: EntryRecord | undefined
  if (ref === 'latest') {
    let cursor: Parameters<Tx['scanEntries']>[2]
    do {
      const page = await tx.scanEntries({ conversationId: from }, SCAN_PAGE, cursor)
      entry = page.items.find((item) => imagesOf(item).length > 0)
      cursor = page.next
    } while (!entry && cursor !== undefined)
    if (!entry) throw new Error('images: "latest" found no entry with images in this conversation')
  } else {
    if (!Number.isInteger(ref) || ref < 1)
      throw new Error('images must be "latest" or the id of an entry with images')
    entry = (
      await tx.scanEntries(
        {
          conversationId: from,
          minEntryId: ref as EntryId,
          maxEntryId: ref as EntryId,
        },
        1,
      )
    ).items[0]
    if (!entry) throw new Error(`images: entry ${ref} is not in this conversation`)
  }
  const images = imagesOf(entry)
  if (!images.length) throw new Error(`images: entry ${entry.id} has no images`)
  if (images.length > maxImages)
    throw new Error(
      `images: entry ${entry.id} has ${images.length} images; at most ${maxImages} go along`,
    )
  for (const image of images)
    if (
      !imageMimeTypes.includes(image.mimeType) ||
      Buffer.byteLength(image.data, 'base64') > maxImageBytes
    )
      throw new Error(`images: entry ${entry.id} has an unsupported image or one over 2 MiB`)
  return { entry: entry.id, count: images.length }
}
/**
 * The images of entry `id` as model content, each after a caption naming where it came from: the tool call whose
 * result holds it (`screenshot url=/x`) or an input, and its place ("Image 2 of 3"). The recipient can check that an
 * image is the one the text describes before passing it on. Entries never change, so a replay gets the same content.
 */
export async function forwarded(tx: Tx, id: EntryId) {
  const entry = await tx.entry(id)
  const total = imagesOf(entry).length
  const content: (TextContent | ImageContent)[] = []
  for (const message of entry?.model ?? []) {
    if (
      (message.role !== 'user' && message.role !== 'toolResult') ||
      typeof message.content === 'string'
    )
      continue
    const source =
      message.role === 'toolResult'
        ? await call(tx, entry!, message.toolCallId, message.toolName)
        : 'an input'
    for (const block of message.content)
      if (block.type === 'image')
        content.push(
          {
            type: 'text',
            text: `Image ${content.length / 2 + 1} of ${total} (entry ${id}, ${source}):`,
          },
          { type: 'image', data: block.data, mimeType: block.mimeType },
        )
  }
  return content
}
/** Tool call `toolCallId` as `name key=value …`, from the response before `entry` that made it; else just `name`. */
async function call(tx: Tx, entry: EntryRecord, toolCallId: string, name: string) {
  const before = await tx.scanEntries(
    { conversationId: entry.conversationId, maxEntryId: (entry.id - 1) as EntryId },
    SCAN_PAGE,
  )
  for (const item of before.items)
    for (const message of item.model ?? [])
      if (message.role === 'assistant')
        for (const block of message.content)
          if (block.type === 'toolCall' && block.id === toolCallId) {
            const args = Object.entries(block.arguments).map(
              ([key, value]) =>
                `${key}=${clip(typeof value === 'string' ? value : JSON.stringify(value), 80)}`,
            )
            return clip([name, ...args].join(' '), 200)
          }
  return name
}
/** `text` on one line, at most `max` characters. */
const clip = (text: string, max: number) => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}
export const imagesParameter = Type.Union([Type.Literal('latest'), Type.Integer({ minimum: 1 })], {
  description:
    'Forward images from your conversation: "latest" for the newest input or tool result (screenshot) with images, or that entry\'s id.',
})
