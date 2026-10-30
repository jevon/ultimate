import { createContext } from 'react'

/** The thread a transcript inside it shows alone (`ThreadView`); cards there show open, not folded. */
export const ThreadContext = createContext<number | undefined>(undefined)
