import WebSocket from 'ws';
import dotenv from 'dotenv';
dotenv.config();

const apiKey = process.env.OPENAI_API_KEY;

const openAiUrl = 'wss://api.openai.com/v1/realtime?model=gpt-realtime-mini';
const ws = new WebSocket(openAiUrl, {
  headers: {
    Authorization: 'Bearer ' + apiKey,
  }
});

ws.on('open', () => {
  console.log('SUCCESS: OpenAI Realtime WS connected!');
  ws.send(JSON.stringify({
    type: 'session.update',
    session: {
      type: 'realtime',
      instructions: 'You are a helpful AI assistant.',
      audio: {
        output: { voice: 'alloy' }
      }
    }
  }));

  setTimeout(() => {
    ws.send(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Hello!' }]
      }
    }));
    ws.send(JSON.stringify({ type: 'response.create' }));
  }, 500);
});

ws.on('message', (data) => {
  console.log('RECEIVED EVENT:', JSON.parse(data.toString()).type);
});

ws.on('error', (err) => {
  console.error('ERROR: OpenAI WS Error:', err);
});

ws.on('close', (code, reason) => {
  console.log('CLOSED:', code, reason.toString());
});
