// «Притворная» модель для тестов и демо: маленький сервер, который отвечает как OpenAI-совместимый.
// script(messages, tools, номер_запроса) решает, что «ответит модель»:
//   { content: 'текст' }                              — обычный ответ
//   { toolCall: { name: 'read_file', args: {...} } }  — просьба вызвать инструмент
//   { status: 429 }                                   — имитация ошибки
//   { delayMs: 500, content: '...' }                  — ответ с задержкой (медленная модель)
import http from 'node:http';

export async function startFakeModel(script) {
  const requests = [];

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
      res.writeHead(404);
      return res.end();
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(body);

    const reply = script(body.messages, body.tools ?? [], requests.length);
    if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs)); // имитация медленной модели
    if (reply.status) {
      res.writeHead(reply.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'имитация ошибки' }));
    }

    const message = { role: 'assistant', content: reply.content ?? '' };
    if (reply.toolCall) {
      message.tool_calls = [
        { id: `call_${requests.length}`, type: 'function', function: { name: reply.toolCall.name, arguments: JSON.stringify(reply.toolCall.args) } },
      ];
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 20, completion_tokens: 10 } }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    requests,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
}
