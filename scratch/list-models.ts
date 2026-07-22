import dotenv from 'dotenv';
dotenv.config();
import { openai } from '../src/utils/openai';

async function main() {
  const models = await openai.models.list();
  const realtimeModels = models.data.filter(m => m.id.includes('realtime'));
  console.log('Realtime Models available on this API Key:');
  console.log(realtimeModels.map(m => m.id));
}

main().catch(err => console.error(err));
