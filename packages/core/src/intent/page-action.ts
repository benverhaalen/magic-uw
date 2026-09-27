import { baseArgs } from './action-args';
import type { ActionSpec, ResolvedArgs } from './types';
const PAGES = { home: 'today', courses: 'courses', calendar: 'calendar', 'my uw': 'myuw' } as const;
const clause = /^(?:please )?(?:open|show|go to|take me to)(?: my| the)? (home|courses|calendar|my uw)(?: please)?$/u;
/** Same exact-navigation action for every input mode. A correction is accepted only when every clause is complete. */
export function pageDestination(text: string): typeof PAGES[keyof typeof PAGES] | null {
  const clauses = text.trim().toLowerCase().replace(/[.!?]+$/u, '').split(/\s*[,;]?\s+actually\s*[,;]?\s*/u);
  const pages = clauses.map(value => { const m = clause.exec(value.trim()); return m ? PAGES[m[1] as keyof typeof PAGES] : null; });
  return pages.length && pages.every(Boolean) ? pages.at(-1)! : null;
}
export const openPage: ActionSpec<ResolvedArgs> = {
  name: 'page.open', description: 'Open Home, Courses, My UW, or Calendar in the app.', slots: {}, argsSchema: baseArgs,
  matchOn: 'raw', examples: ['open calendar', 'open home', 'open calendar actually open my courses'],
  patterns: [/^(?:please )?(?:open|show|go to|take me to)(?: my| the)? (?:home|courses|calendar|my uw)(?: please)?(?:[,;]? actually (?:please )?(?:open|show|go to|take me to)(?: my| the)? (?:home|courses|calendar|my uw)(?: please)?)*[.!?]*$/u],
  label: args => `Open ${pageDestination(args.text) ?? 'page'}`,
  async run(args) { const page = pageDestination(args.text); return page ? { navigate: { view: page } } : { message: 'Say the full page name to open it.' }; },
};
