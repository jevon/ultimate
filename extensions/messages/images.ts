import { Type } from '@earendil-works/pi-ai'
import type { ImageContent, TextContent } from '@earendil-works/pi-ai'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId, EntryId, EntryRecord, Tx } from '@earendil-works/pi-durable'
import { imagesOf } from '../../lib/entries.ts'
import { imageMimeTypes, maxImageBytes, maxImages } from '../../shared/protocol.ts'
import { Roots } from '../lineage/api.ts'
import { Started } from './addresses.ts'

/**
 * Which images to forward: `latest`, the newest entry in the sender's conversation with images (a pasted input or a
 * tool result such as a screenshot), or the id of an entry with images in the sender's tree.
 */
export type ImagesRef = 'latest' | number
export const SCAN_PAGE = 200
/** Conversation `id` and those above it: its owner (a subagent's) or fork source (a branch's), up to a top. */
async function above(tx: Tx, id: ConversationId) {
  const chain: ConversationId[] = []
  for (let record = await tx.conversation(id); record;) {
    chain.push(record.id)
    const up = record.owner?.conversationId ?? record.parent?.conversationId
    record = up === undefined ? undefined : await tx.conversation(up)
  }
  return chain
}
/**
 * Whether conversation `source` is in `sender`'s tree: under the same root, or under `sender` itself or a branch it
 * started. @ultimate stands outside every tree, so it reaches the branches it started and their subagents.
 */
async function inTree(tx: Tx, sender: ConversationId, source: ConversationId) {
  const sources = await above(tx, source)
  if (sources.includes(sender)) return true
  const { roots } = await tx.doc(Roots, ROOT_CONVERSATION_ID)
  const root = (await above(tx, sender)).find((id) => roots.includes(id))
  if (root !== undefined && root === sources.find((id) => roots.includes(id))) return true
  for (const id of sources) if ((await tx.doc(Started, id)).by === sender) return true
  return false
}
/**
 * Resolve `ref` to the entry holding the images, checking the limits: `latest` and an id in conversation `from`'s
 * visible history, else an id in a conversation of `sender`'s tree (`sender` is `from` unless `from` acts for it).
 */
export async function resolveImages(
  tx: Tx,
  from: ConversationId,
  ref: ImagesRef,
  sender: ConversationId = from,
) {
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
    if (!entry) {
      entry = await tx.entry(ref as EntryId)
      if (!entry) throw new Error(`images: there is no entry ${ref}`)
      if (!(await inTree(tx, sender, entry.conversationId)))
        throw new Error(
          `images: entry ${ref} is in #${entry.conversationId}, outside your conversation's tree`,
        )
    }
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
 * The images of entry `id` as model content, each after a caption naming where it came from: its conversation, the
 * tool call whose result holds it (`screenshot url=/x`) or an input, and its place ("Image 2 of 3"). The recipient can check that an
 * image is the one the text describes before passing it on. Entries never change, so a replay gets the same content.
 */
export async function forwarded(tx: Tx, id: EntryId) {
  const entry = await tx.entry(id)
  const total = imagesOf(entry).length
  const content: (TextContent | ImageContent)[] = []
  let n = 0
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
            text: `Image ${++n} of ${total} (entry ${id} in #${entry!.conversationId}, ${source}):`,
          },
          { type: 'image', data: block.data, mimeType: block.mimeType },
        )
  }
  return content
}
/**
 * Tool call `toolCallId` as `name key=value …`, from the response before `entry` that made it, searched in small pages
 * (entries carry their images) up to `SCAN_PAGE` entries back; else just `name`.
 */
async function call(tx: Tx, entry: EntryRecord, toolCallId: string, name: string) {
  let cursor: Parameters<Tx['scanEntries']>[2]
  for (let scanned = 0; scanned < SCAN_PAGE; scanned += 10) {
    const page = await tx.scanEntries(
      { conversationId: entry.conversationId, maxEntryId: (entry.id - 1) as EntryId },
      10,
      cursor,
    )
    for (const item of page.items)
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
    cursor = page.next
    if (cursor === undefined) break
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
    'Forward images: "latest" for the newest input or tool result (screenshot) with images in your conversation, or the id of an entry with images in your conversation or your tree (the branches you started, your subagents, conversations under your root).',
})
