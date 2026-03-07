const OpenAI = require('openai')

let openaiClient = null

function getClient() {
  if (!openaiClient && process.env.OPENAI_API_KEY) {
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  }
  return openaiClient
}

/**
 * Generate a chat completion using OpenAI
 */
async function chat(systemPrompt, messages, model = 'gpt-4o') {
  const client = getClient()
  if (!client) throw new Error('OpenAI not configured. Set OPENAI_API_KEY.')

  const completion = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages
    ],
    max_tokens: 500,
    temperature: 0.7,
  })

  return completion.choices[0].message.content
}

/**
 * Analyze sentiment of a conversation
 */
async function analyzeSentiment(text) {
  const client = getClient()
  if (!client) return 'neutral'

  try {
    const completion = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'Analyze the sentiment of the following conversation text. Respond with exactly one word: positive, neutral, or negative.'
        },
        { role: 'user', content: text }
      ],
      max_tokens: 10,
      temperature: 0,
    })

    const result = completion.choices[0].message.content.toLowerCase().trim()
    if (['positive', 'neutral', 'negative'].includes(result)) return result
    return 'neutral'
  } catch (err) {
    console.error('Sentiment analysis error:', err.message)
    return 'neutral'
  }
}

/**
 * Generate speech from text using OpenAI TTS
 */
async function textToSpeech(text, voice = 'alloy') {
  const client = getClient()
  if (!client) throw new Error('OpenAI not configured. Set OPENAI_API_KEY.')

  const response = await client.audio.speech.create({
    model: 'tts-1',
    voice,
    input: text,
    response_format: 'mp3',
  })

  return Buffer.from(await response.arrayBuffer())
}

/**
 * Transcribe audio using OpenAI Whisper
 */
async function speechToText(audioBuffer, language = 'es') {
  const client = getClient()
  if (!client) throw new Error('OpenAI not configured. Set OPENAI_API_KEY.')

  const file = new File([audioBuffer], 'audio.wav', { type: 'audio/wav' })
  const transcription = await client.audio.transcriptions.create({
    model: 'whisper-1',
    file,
    language,
  })

  return transcription.text
}

module.exports = {
  chat,
  analyzeSentiment,
  textToSpeech,
  speechToText,
  getClient,
}
