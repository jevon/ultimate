import { MoonIcon } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useDialog, useDocOf, useUltimate } from '@/sdk'
import { NextChapter } from './sleep.tsx'
import { DreamDoc } from './refs.ts'

/** The dialog the pinned line opens: the Fall asleep card. */
export const nextDialog = 'dream.next'

/** The prepared next chapter while it waits for Fall asleep, or a sleep that failed or runs. */
function usePinned() {
  const doc = useDocOf(1, DreamDoc)
  return doc?.prepared && doc.sleep?.phase !== 'asleep' ? doc : undefined
}

/** In the status line, on every surface and on phones, while a fresh chapter is prepared and not yet slept into. */
export function DreamStatus() {
  const doc = usePinned()
  const actions = useUltimate()
  if (!doc?.prepared) return null
  const failed = doc.sleep?.phase === 'failed'
  return (
    <button
      className="-mx-1 flex min-w-0 cursor-pointer items-center gap-1.5 rounded-sm px-1 transition-colors hover:bg-accent hover:text-foreground"
      data-dream-status={doc.prepared.chapter}
      onClick={() => actions.open(nextDialog)}
      title={`Chapter ${doc.prepared.chapter} is prepared: show the Fall asleep card`}
      type="button"
    >
      <MoonIcon className="size-3 shrink-0 text-brand" />
      <span className="truncate">
        {doc.sleep ? (failed ? 'falling asleep failed' : 'falling asleep') : 'ready to fall asleep'}
      </span>
    </button>
  )
}

export function NextDialog() {
  const [open, setOpen] = useDialog(nextDialog)
  const doc = usePinned()
  return (
    <Dialog onOpenChange={setOpen} open={open && !!doc}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] grid-cols-[minmax(0,1fr)] gap-0 overflow-y-auto p-0 sm:max-w-[40rem]"
        data-dream-next-dialog
      >
        <DialogTitle className="sr-only">Fall asleep</DialogTitle>
        <DialogDescription className="sr-only">The next chapter I prepared</DialogDescription>
        {doc?.prepared && (
          <NextChapter
            className="rounded-none border-0"
            prepared={doc.prepared}
            sleep={doc.sleep}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
