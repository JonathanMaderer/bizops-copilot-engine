import { handleTeach } from '../src/api/routes.ts';
import { vercelHandler } from '../src/api/vercel.ts';

export default vercelHandler('POST', handleTeach);
