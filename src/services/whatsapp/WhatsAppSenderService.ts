/**
 * WhatsApp Cloud API Sender Service
 * Handles outbound messages, read receipts, and long-message splitting.
 */

export function splitMessageText(text: string, maxLen = 4000): string[] {
  if (!text || text.length <= maxLen) return [text || ''];
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let splitIndex = remaining.lastIndexOf('\n', maxLen);
    if (splitIndex <= 0) {
      splitIndex = remaining.lastIndexOf(' ', maxLen);
    }
    if (splitIndex <= 0) {
      splitIndex = maxLen;
    }
    const chunk = remaining.substring(0, splitIndex).trim();
    if (chunk) chunks.push(chunk);
    remaining = remaining.substring(splitIndex).trim();
  }
  if (remaining.trim()) {
    chunks.push(remaining.trim());
  }
  return chunks;
}

export async function sendText(to: string, body: string): Promise<any> {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_ACCESS_TOKEN;

  if (!phoneNumberId || !token) {
    console.error('[WHATSAPP SENDER ERROR] Missing WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN');
    return { success: false, error: 'missing_credentials' };
  }

  const url = `https://graph.facebook.com/v25.0/${phoneNumberId}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: {
      body,
      preview_url: false,
    },
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data: any = await response.json();
    console.log(`[WHATSAPP SENDER] Outbound status: ${response.status} to: ${to}`, JSON.stringify(data));
    return { status: response.status, data };
  } catch (err: any) {
    console.error('[WHATSAPP SENDER ERROR] Failed to send text:', err?.message || err);
    return { success: false, error: err?.message || err };
  }
}

export async function markAsRead(messageId: string): Promise<any> {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_ACCESS_TOKEN;

  if (!phoneNumberId || !token || !messageId) {
    return { success: false, error: 'missing_parameters' };
  }

  const url = `https://graph.facebook.com/v25.0/${phoneNumberId}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: messageId,
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data: any = await response.json();
    console.log(`[WHATSAPP SENDER] markAsRead status: ${response.status} for messageId: ${messageId}`, JSON.stringify(data));
    return { status: response.status, data };
  } catch (err: any) {
    console.error('[WHATSAPP SENDER ERROR] Failed to mark as read:', err?.message || err);
    return { success: false, error: err?.message || err };
  }
}

export async function sendLongText(to: string, body: string): Promise<any[]> {
  const chunks = splitMessageText(body, 4000);
  const results: any[] = [];
  for (const chunk of chunks) {
    if (chunk.trim()) {
      const res = await sendText(to, chunk);
      results.push(res);
    }
  }
  return results;
}

export const WhatsAppSenderService = {
  sendText,
  markAsRead,
  sendLongText,
  splitMessageText,
};

export default WhatsAppSenderService;
