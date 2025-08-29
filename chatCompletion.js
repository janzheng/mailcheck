// Minimal Groq Chat Completions client using fetch (for background checker)
export async function groqChatCompletion(apiKey, payload) {
  // console.log('>>> [groqChatCompletion] Payload:', payload);
  let response;
  try {
    response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });
  } catch (err) {
    console.error('>>> [groqChatCompletion] Network error:', err && err.message ? err.message : String(err));
    throw err;
  }
  console.log('>>> [groqChatCompletion] Status:', response.status);
  if (!response.ok) {
    const text = await response.text();
    console.error('>>> [groqChatCompletion] Error response:', response.status, text);
    throw new Error(`Groq API error: ${response.status} ${text}`);
  }
  const json = await response.json();
  // try { console.log('>>> [groqChatCompletion] JSON:', JSON.stringify(json)); } catch (_) {}
  return json;
}


