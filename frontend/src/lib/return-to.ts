import { useLocation } from 'react-router-dom';
import { z } from 'zod';

const returnSchema = z.object({ returnTo: z.object({ to: z.string(), label: z.string() }) });

/** The router state a link carries so the page it opens can offer the way back: where it came from, and what to call it. */
export const returnState = (to: string, label: string) => ({ returnTo: { to, label } });

/** The page this one was opened from, when a link said so; null on a page opened any other way. */
export function useReturnTo() {
  const parsed = returnSchema.safeParse(useLocation().state);
  return parsed.success ? parsed.data.returnTo : null;
}
