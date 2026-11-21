import { Inngest } from 'inngest';
export function createInngestClient(config = {}) { return new Inngest({ id: 'github-pr-review-app', ...config }); }
export const inngest = createInngestClient({ isDev: true });
