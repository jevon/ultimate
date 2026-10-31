import { defineExtension, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { BACKGROUND_CONTEXT as context, withAbortSignal } from '@earendil-works/chord/context'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Messages, MessagesApi } from '../messages/api.ts'
import type { Message, Question } from '../messages/api.ts'
import { implementAction } from '../../lib/actions.ts'
import { AnswerAction, DismissAction } from './refs.ts'

const open = (message: Message) =>
  message.to === 'user' && message.reply && message.state === 'delivered'
const NOT_OPEN = 'These questions are no longer open'

function validAnswers(value: unknown): value is { question: string; answer: string }[] {
  return (
    Array.isArray(value) &&
    value.every(
      (a: { question?: unknown; answer?: unknown } | null) =>
        a && typeof a.question === 'string' && typeof a.answer === 'string' && a.answer.trim(),
    )
  )
}
function checkAnswers(answers: { question: string }[], questions: Question[]) {
  if (
    new Set(answers.map((a) => a.question)).size !== answers.length ||
    answers.some((a) => !questions.some((q) => q.text === a.question))
  )
    throw new Error('Unknown question')
}
/**
 * The keys of the chosen options, in option order: "a", "a,c"; none when an answer names no option or one without a
 * key. A multi answer is its labels in option order joined by ", ", which labels may hold too: it names options only
 * when exactly one reading of it does.
 */
function keysOf(question: Question, answer: string) {
  const options = question.options ?? []
  if (question.kind !== 'multi') return options.find((o) => o.label === answer)?.key ?? ''
  const readings: (string | undefined)[][] = []
  const read = (at: number, from: number, keys: (string | undefined)[]) => {
    for (let i = from; i < options.length && readings.length < 2; i++) {
      const end = at + options[i].label.length
      if (!answer.startsWith(options[i].label, at)) continue
      if (end === answer.length) readings.push([...keys, options[i].key])
      else if (answer.startsWith(', ', end)) read(end + 2, i + 1, [...keys, options[i].key])
    }
  }
  read(0, 0, [])
  const [keys] = readings
  return readings.length === 1 && keys.every(Boolean) ? keys.join(',') : ''
}
/**
 * The reply naming each answer by the message's own numbering: `1a. Topic: label` for an option (`2a,c.` for
 * several), `3: text` for typed text or a rating, `Topic: answer` when the message numbered nothing; a note from the
 * card's field follows the answers.
 */
export function answerText(
  answers: { question: string; answer: string }[],
  questions: Question[],
  note?: string,
) {
  const lines = answers.map(({ question, answer }) => {
    const q = questions.find((candidate) => candidate.text === question)!
    const keys = keysOf(q, answer)
    if (!q.ref) return `${q.text}: ${answer}`
    return keys ? `${q.ref}${keys}. ${q.text}: ${answer}` : `${q.ref}: ${answer}`
  })
  if (note?.trim()) lines.push(answers.length ? `Note: ${note.trim()}` : note.trim())
  return lines.join('\n\n')
}

export const userActions = ['answer', 'dismiss']
export const actions = {
  /** Answer an open message from its questions, with a note, or as free text: a user reply to its sender. */
  answer: implementAction(AnswerAction, async (args, { host, signal, device }) => {
    const data = args as {
      messageId: number
      answers?: { question: string; answer: string }[]
      note?: unknown
      text?: unknown
    }
    const text = typeof data?.text === 'string' ? data.text.trim() : undefined
    const note = typeof data?.note === 'string' ? data.note.trim() : undefined
    const answers = data?.answers ?? []
    if (
      !data ||
      !Number.isSafeInteger(data.messageId) ||
      (text === undefined
        ? !validAnswers(answers) || (!answers.length && !note)
        : !text || data.answers !== undefined || note)
    )
      throw new Error('Invalid answers')
    const reply = await host.harness().commit(async (tx) => {
      const log = await tx.doc(Messages, ROOT_CONVERSATION_ID)
      const message = log.messages.find((m) => m.id === data.messageId)
      if (!message || !open(message)) throw new Error(NOT_OPEN)
      if (text !== undefined) return text
      checkAnswers(answers, message.questions ?? [])
      return answerText(answers, message.questions ?? [], note)
    }, context)
    return {
      id: await host
        .need(MessagesApi)
        .answer(data.messageId, reply, withAbortSignal(signal, context), device),
    }
  }),
  /** Close an open message to the user unanswered; its sender gets a one-way note. */
  dismiss: implementAction(DismissAction, async (args, { host, signal, device }) => {
    const data = args as { messageId: number }
    if (!data || !Number.isSafeInteger(data.messageId)) throw new Error('Invalid message')
    return {
      id: await host
        .need(MessagesApi)
        .dismiss(data.messageId, withAbortSignal(signal, context), device),
    }
  }),
}

export default function questionsExtension(host: ExtensionHost) {
  // Core, always on; resolved where it is called, declared here so the catalogue lists it.
  host.need(MessagesApi)
  return defineExtension({ name: 'questions' })
}
