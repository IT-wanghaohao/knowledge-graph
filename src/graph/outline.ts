/** Validate model output before showing it in the import preview. */
export function modelOutline(content: string): string {
  const text = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  let data: unknown
  try { data = JSON.parse(text) } catch { throw new Error('模型没有返回有效的大纲，请重试') }
  if (!Array.isArray(data) || !data.length || data.length > 300) throw new Error('模型没有返回可预览的大纲')
  let previous = -1
  return data.map((row) => {
    if (!row || typeof row.title !== 'string' || !row.title.trim() || row.title.length > 240 ||
      !Number.isInteger(row.depth) || row.depth < 0 || row.depth > previous + 1 || row.depth > 20) {
      throw new Error('模型返回的大纲层级无效')
    }
    previous = row.depth
    const title = row.title.replace(/\s*\n\s*/g, ' ').trim().replace(/[\\#*_[\]]/g, '\\$&')
    return '  '.repeat(row.depth) + '- ' + title
  }).join('\n')
}

export async function generateOutline(text: string, model: string): Promise<string> {
  if (!text.trim() || !model.trim()) throw new Error('请填写本机模型名称和要整理的文本')
  let response: Response
  try {
    // A fixed loopback endpoint keeps selected text on this device.
    response = await fetch('http://127.0.0.1:11434/v1/chat/completions', {
      method: 'POST',
      credentials: 'omit',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model.trim(),
        messages: [
          { role: 'system', content: '按材料生成简明大纲。只返回 JSON 数组，每项包含 title 和整数 depth。首项 depth 为 0，相邻项深度最多增加 1，最多 100 项。' },
          { role: 'user', content: text },
        ],
      }),
      signal: AbortSignal.timeout(45_000),
    })
  } catch { throw new Error('无法连接本机 Ollama，请检查模型服务和浏览器访问权限') }
  if (!response.ok) throw new Error('本机模型未能生成大纲，请核对模型名称')
  const data = await response.json()
  const content: unknown = data.choices?.[0]?.message?.content
  if (typeof content !== 'string') throw new Error('模型没有返回大纲')
  return modelOutline(content)
}
